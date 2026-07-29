import { getDb, mutate, makeId } from './db.js';
import { generatePack, rollSerialized } from './opener.js';
import { pickSerial, serializedFloorUsd } from '../serialized.js';
import { boxSizesFor, productsAvailable } from './collation.js';
import { cachedPackEv } from './packvalue.js';
import { PACK_TYPES, packTypeById } from '../packs.js';
import { setEntry } from './registry.js';
import { packPriceUsd as heurPackUsd, boxPriceUsd as heurBoxUsd, sealedPremium } from '../pricing.js';
import { getSealed } from './tcgplayer.js';
import { usdToGold, cardMarketGold, cardSellGold } from '../economy.js';
import { newStats } from './auth.js';

// ── Reads ──────────────────────────────────────────────────────
export function getWallet(userId) {
	const db = getDb();
	return db.wallets[userId] || { gold: 0 };
}

export function getInventory(userId) {
	const db = getDb();
	return db.inventory[userId] || [];
}

export function getCollection(userId) {
	const db = getDb();
	return db.collections[userId] || [];
}

export function getStats(userId) {
	const db = getDb();
	return db.stats[userId] || newStats();
}

export function getOpenings(userId) {
	const db = getDb();
	return db.openings[userId] || [];
}

/** Group unopened packs by set + type for the Packs screen. */
export function inventorySummary(userId) {
	const inv = getInventory(userId);
	const groups = {};
	for (const item of inv) {
		const key = `${item.setCode}:${item.packTypeId}`;
		if (!groups[key]) {
			const set = setEntry(item.setCode);
			groups[key] = {
				key,
				setCode: item.setCode,
				setName: set?.name || item.setCode.toUpperCase(),
				packTypeId: item.packTypeId,
				packName: packTypeById(item.packTypeId)?.name || item.packTypeId,
				accent: packTypeById(item.packTypeId)?.accent || 'primary',
				// what one unopened pack sells back for (full current market value)
				sellGold: set ? packPriceGold(set, item.packTypeId) : 0,
				count: 0,
				ids: []
			};
		}
		groups[key].count++;
		groups[key].ids.push(item.id);
	}
	return Object.values(groups).sort((a, b) => a.setName.localeCompare(b.setName));
}

// ── Pricing (real TCGplayer sealed prices, heuristic fallback) ──
// A pack/box price is the live TCGplayer market price when we have one,
// otherwise the MSRP×vintage estimate from pricing.js.

/**
 * Packs per box. MTGJSON's sealedProduct records the real figure
 * (contents.sealed[].count), which is authoritative and varies by set — 2XM
 * boxes are 24 packs, not the 36 a constant would assume. Falls back to the
 * product default only when the set has no cached sealed data yet.
 */
export function boxSizeFor(set, packTypeId) {
	const known = boxSizesFor(set?.code);
	// MTGJSON files both classic Draft Boosters and Mystery Boosters under the
	// `draft` subtype, and very old sets under `default`.
	const alias = packTypeId === 'mystery' ? 'draft' : packTypeId === 'draft' ? 'default' : null;
	return (
		known?.[packTypeId] ||
		(alias ? known?.[alias] : null) ||
		(packTypeId === 'draft' ? known?.default : null) ||
		PACK_TYPES[packTypeId]?.boxSize ||
		1
	);
}

/**
 * Vintage sealed product that has no live listing. The MSRP-times-age heuristic
 * prices an Alpha booster at $43 while the singles inside average into the
 * thousands, so for old product the exact expected value of the real print
 * sheets acts as a floor.
 *
 * Deliberately NOT applied to in-print product: a modern pack whose singles are
 * worth more than the pack is a normal, real situation (it is why people crack
 * Mystery Boosters), and treating EV as a floor there would invent a price the
 * market does not charge.
 */
const VINTAGE_BEFORE = Date.parse('2006-01-01');

function evFloor(set, packTypeId) {
	if (!set?.released || Date.parse(set.released) >= VINTAGE_BEFORE) return null;
	const ev = cachedPackEv(set.code, packTypeId);
	if (ev == null) return null;
	// Sealed vintage trades well above the value of the cards inside it; the
	// multiple is measured, not assumed. See sealedPremium() in pricing.js.
	return ev * sealedPremium(set.released);
}

export function packPriceUsd(set, packTypeId) {
	const live = getSealed(set.code)?.[packTypeId]?.pack;
	// A real listing is the market price — never second-guess it with an estimate.
	if (live && live > 0) return live;
	const base = heurPackUsd(set, packTypeId);
	const ev = evFloor(set, packTypeId);
	return ev != null && ev > base ? ev : base;
}
export function boxPriceUsd(set, packTypeId) {
	const live = getSealed(set.code)?.[packTypeId]?.box;
	if (live && live > 0) return live;
	// derive a box estimate from a live pack price if only the pack is known
	const livePack = getSealed(set.code)?.[packTypeId]?.pack;
	const t = PACK_TYPES[packTypeId];
	const size = boxSizeFor(set, packTypeId);
	if (livePack && livePack > 0 && t) return livePack * size * 0.9;
	// Same floor as a pack, scaled by the box — a sealed box of Alpha cannot be
	// worth less than the packs it contains. Only used when nothing is listed.
	const heur = heurBoxUsd(set, packTypeId);
	const ev = evFloor(set, packTypeId);
	const evBox = ev != null ? ev * size * 0.9 : null;
	return evBox != null && evBox > heur ? evBox : heur;
}
export function packPriceGold(set, packTypeId) {
	return usdToGold(packPriceUsd(set, packTypeId));
}
export function boxPriceGold(set, packTypeId) {
	return usdToGold(boxPriceUsd(set, packTypeId));
}

/** Whether a pack price came from live TCGplayer data (vs an estimate). */
export function priceIsLive(set, packTypeId, kind = 'pack') {
	const v = getSealed(set.code)?.[packTypeId]?.[kind];
	return !!(v && v > 0);
}

/** Cheapest pack price (gold) for a set, for "from X" labels. */
export function fromPriceGold(set) {
	const prices = (set.packTypes || []).map((t) => packPriceGold(set, t));
	return prices.length ? Math.min(...prices) : 0;
}

/** Store products (pack + box) for a set, priced for the current date. */
export function productsForSet(set) {
	const products = [];
	// Once we have real collation for a set, it is authoritative about which
	// products existed; before that we fall back to the date-gated guess.
	//
	// Except where TCGplayer is demonstrably selling the pack: MTGJSON's slice
	// can lag a release (its Avatar data lists no Jumpstart variant, while the
	// Jumpstart Booster has a market price and a product photo). A live price is
	// evidence the product shipped, so it outranks the omission — and collation
	// falls back to the era template, which stamps those packs `estimated`.
	const real = productsAvailable(set.code);
	for (const packTypeId of set.packTypes) {
		const t = PACK_TYPES[packTypeId];
		if (!t) continue;
		if (real && !real.includes(packTypeId) && !priceIsLive(set, packTypeId, 'pack')) continue;
		const packGold = packPriceGold(set, packTypeId);
		const boxGold = boxPriceGold(set, packTypeId);
		products.push({
			kind: 'pack',
			setCode: set.code,
			packTypeId,
			name: t.name,
			cardCount: t.cardCount,
			accent: t.accent,
			blurb: t.blurb,
			priceGold: packGold,
			priceUsd: Number(packPriceUsd(set, packTypeId).toFixed(2)),
			live: priceIsLive(set, packTypeId, 'pack')
		});
		const size = boxSizeFor(set, packTypeId);
		const perPack = boxGold / size;
		const savings = Math.max(0, Math.round((1 - perPack / packGold) * 100));
		products.push({
			kind: 'box',
			setCode: set.code,
			packTypeId,
			name: `${t.name} Box`,
			boxSize: size,
			accent: t.accent,
			blurb: savings > 0 ? `${size} packs — save ${savings}% vs singles.` : `Sealed box of ${size} packs.`,
			priceGold: boxGold,
			priceUsd: Number(boxPriceUsd(set, packTypeId).toFixed(2)),
			live: priceIsLive(set, packTypeId, 'box') || priceIsLive(set, packTypeId, 'pack')
		});
	}
	return products;
}

// ── Buying ─────────────────────────────────────────────────────
export function buy(userId, { setCode, packTypeId, kind }) {
	setCode = String(setCode || '').toLowerCase();
	const set = setEntry(setCode);
	if (!set) return { ok: false, error: 'Unknown set.' };
	if (set.unreleased) return { ok: false, error: 'That set is not released yet.' };
	if (!set.packTypes.includes(packTypeId)) return { ok: false, error: 'That set has no such pack.' };
	const type = packTypeById(packTypeId);
	if (!type) return { ok: false, error: 'Unknown pack type.' };

	const qty = kind === 'box' ? boxSizeFor(set, packTypeId) : 1;
	const price = kind === 'box' ? boxPriceGold(set, packTypeId) : packPriceGold(set, packTypeId);

	const wallet = getWallet(userId);
	if (wallet.gold < price) return { ok: false, error: 'Not enough gold.' };

	mutate((d) => {
		d.wallets[userId].gold -= price;
		const now = Date.now();
		for (let i = 0; i < qty; i++) {
			d.inventory[userId].push({ id: makeId(), setCode, packTypeId, acquiredAt: now });
		}
		const s = (d.stats[userId] ??= newStats());
		s.goldSpent += price;
		if (kind === 'box') s.boxesOpened += 1;
	});

	return { ok: true, added: qty, price, gold: getWallet(userId).gold };
}

// ── Opening ────────────────────────────────────────────────────

/**
 * Stamp serial numbers on any serialized cards in a pack, drawing from a
 * global ledger of what has already been issued. A serialized card is a
 * physical object with a finite print run: The One Ring 001/001 can be pulled
 * exactly once, ever, by one player.
 */
function assignSerials(cards) {
	const serialized = cards.filter((c) => c.serialOf && c.serial == null);
	if (!serialized.length) return;
	mutate((d) => {
		d.serials ??= {};
		for (const c of serialized) {
			const issued = (d.serials[c.id] ??= []);
			const n = pickSerial(issued, c.serialOf);
			if (n == null) {
				// Whole run claimed — downgrade to the plain foil printing.
				c.serialOf = null;
				c.slot = 'rare';
				c.slotLabel = 'Foil Rare / Mythic';
				c.tier = 6.5;
				continue;
			}
			issued.push(n);
			c.serial = n;
			c.valueUsd = Number(serializedFloorUsd(c.serialOf, c.valueUsd).toFixed(2));
		}
	});
}

/** Roll one pack's contents. Touches the serial ledger, nothing else. */
async function rollPack(item) {
	const set = setEntry(item.setCode);
	const pack = await generatePack(item.setCode, item.packTypeId, {
		released: set?.released,
		setType: set?.type
	});
	if (!pack || !pack.cards.length) return null;

	// Serialized cards for the sets MTGJSON does not put on a sheet. The six
	// sets that DO model them (BRO/LTR/MOM/MUL/RVR/LTC) already produced theirs
	// through normal collation above.
	const db0 = getDb();
	const extra = await rollSerialized(item.setCode, item.packTypeId, (id) => db0.serials?.[id] || []);
	if (extra) pack.cards.push(extra);

	// Assign the actual serial number to anything serialized, from a global
	// ledger — two players must never both own #137/250.
	assignSerials(pack.cards);
	return pack;
}

/**
 * Bank a batch of rolled packs in ONE write: drop them from inventory, add the
 * cards, fold in the stats, log the rips. Ripping a 36-pack box is a single
 * flush of .data/db.json rather than 36 of them.
 * @param {{item:object, pack:object}[]} opened
 */
function commitOpenings(userId, opened, now) {
	mutate((d) => {
		const list = d.inventory[userId] || [];
		const coll = (d.collections[userId] ??= []);
		const s = (d.stats[userId] ??= newStats());
		const log = (d.openings[userId] ??= []);

		for (const { item, pack } of opened) {
			// remove exactly this pack from inventory
			const idx = list.findIndex((x) => x.id === item.id);
			if (idx >= 0) list.splice(idx, 1);

			for (const c of pack.cards) coll.push({ ...c, acquiredAt: now, sold: false });

			s.packsOpened += 1;
			s.cardsOpened += pack.cards.length;
			s.bySet[item.setCode] = (s.bySet[item.setCode] || 0) + 1;
			for (const c of pack.cards) {
				if (c.rarity === 'mythic') s.mythicsPulled += 1;
				else if (c.rarity === 'rare') s.raresPulled += 1;
				if (c.foil) s.foilsPulled += 1;
				if (c.treatments?.length) s.treatmentsPulled = (s.treatmentsPulled || 0) + 1;
				if (c.serial != null) s.serializedPulled = (s.serializedPulled || 0) + 1;
				const g = cardMarketGold(c.valueUsd);
				if (!s.bestPull || g > s.bestPull.gold) {
					s.bestPull = {
						name: c.name,
						set: c.set,
						setName: c.setName,
						foil: c.foil,
						finish: c.finish,
						rarity: c.rarity,
						treatments: c.treatments || [],
						serial: c.serial ?? null,
						serialOf: c.serialOf ?? null,
						gold: g,
						image: c.images?.normal || null
					};
				}
			}

			log.unshift({
				id: makeId(),
				at: now,
				setCode: item.setCode,
				setName: pack.setName,
				packTypeId: item.packTypeId,
				cardCount: pack.cards.length,
				valueGold: pack.cards.reduce((a, c) => a + cardMarketGold(c.valueUsd), 0)
			});
		}
		d.openings[userId] = log.slice(0, 30);
	});
}

export async function openPack(userId, inventoryId) {
	const inv = getInventory(userId);
	const item = inventoryId
		? inv.find((x) => x.id === inventoryId)
		: inv[0];
	if (!item) return { ok: false, error: 'No pack to open.' };

	const pack = await rollPack(item);
	if (!pack) return { ok: false, error: `Card data for ${item.setCode.toUpperCase()} is unavailable.` };

	commitOpenings(userId, [{ item, pack }], Date.now());
	return { ok: true, pack, gold: getWallet(userId).gold };
}

/** Hard ceiling on one mass rip — a case of Play Boosters is 216 packs. */
export const MASS_OPEN_MAX = 216;

/**
 * Rip many packs at once. Packs are drawn from the caller's inventory matching
 * `setCode`/`packTypeId` (or from the front of the vault when neither is given),
 * rolled one at a time so collation and pricing caches warm normally, then
 * banked in a single write.
 *
 * @param {string} userId
 * @param {{setCode?:string, packTypeId?:string, ids?:string[], count?:number}} opts
 */
export async function openPacks(userId, { setCode, packTypeId, ids, count } = {}) {
	const inv = getInventory(userId);
	let queue;
	if (Array.isArray(ids) && ids.length) {
		const want = new Set(ids.map(String));
		queue = inv.filter((x) => want.has(String(x.id)));
	} else {
		queue = inv.filter(
			(x) =>
				(!setCode || x.setCode === String(setCode).toLowerCase()) &&
				(!packTypeId || x.packTypeId === packTypeId)
		);
	}
	const n = Math.min(queue.length, Math.max(1, Number(count) || queue.length), MASS_OPEN_MAX);
	queue = queue.slice(0, n);
	if (!queue.length) return { ok: false, error: 'No packs to open.' };

	const opened = [];
	const failed = [];
	for (const item of queue) {
		let pack = null;
		try {
			pack = await rollPack(item);
		} catch {
			pack = null;
		}
		if (pack) opened.push({ item, pack });
		else failed.push(item.setCode.toUpperCase());
	}
	if (!opened.length) {
		return { ok: false, error: `Card data for ${[...new Set(failed)].join(', ')} is unavailable.` };
	}

	commitOpenings(userId, opened, Date.now());

	const cards = opened.flatMap((o) => o.pack.cards);
	return {
		ok: true,
		packsOpened: opened.length,
		// Packs whose set has no usable card data are left in the vault, not lost.
		skipped: failed.length,
		estimated: opened.some((o) => o.pack.estimated),
		cards,
		valueGold: cards.reduce((a, c) => a + cardMarketGold(c.valueUsd), 0),
		gold: getWallet(userId).gold
	};
}

// ── Selling ────────────────────────────────────────────────────
export function sellCards(userId, uids) {
	const set = new Set(uids);
	let earned = 0;
	let sold = 0;
	const soldNames = [];

	mutate((d) => {
		const coll = d.collections[userId] || [];
		const keep = [];
		for (const c of coll) {
			if (set.has(c.uid)) {
				earned += cardSellGold(c.valueUsd);
				sold += 1;
				soldNames.push(c.name);
			} else {
				keep.push(c);
			}
		}
		d.collections[userId] = keep;
		d.wallets[userId].gold += earned;
		const s = (d.stats[userId] ??= newStats());
		s.goldEarned += earned;
		s.cardsSold += sold;
	});

	return { ok: true, earned, sold, soldNames, gold: getWallet(userId).gold };
}

/** Sell unopened packs back to the store at full current market value. */
export function sellPacks(userId, { setCode, packTypeId, qty = 1 }) {
	setCode = String(setCode || '').toLowerCase();
	const set = setEntry(setCode);
	if (!set) return { ok: false, error: 'Unknown set.' };
	const unit = packPriceGold(set, packTypeId);

	let sold = 0;
	let earned = 0;
	mutate((d) => {
		const inv = d.inventory[userId] || [];
		const keep = [];
		for (const item of inv) {
			if (sold < qty && item.setCode === setCode && item.packTypeId === packTypeId) {
				sold += 1;
				earned += unit;
			} else {
				keep.push(item);
			}
		}
		d.inventory[userId] = keep;
		d.wallets[userId].gold += earned;
		const s = (d.stats[userId] ??= newStats());
		s.goldEarned += earned;
		s.packsSold = (s.packsSold || 0) + sold;
	});

	if (sold === 0) return { ok: false, error: 'No matching packs to sell.' };
	return { ok: true, sold, earned, gold: getWallet(userId).gold };
}

/** Value of the whole collection at market, in gold. */
export function collectionValue(userId) {
	const coll = getCollection(userId);
	return coll.reduce((a, c) => a + cardMarketGold(c.valueUsd), 0);
}
