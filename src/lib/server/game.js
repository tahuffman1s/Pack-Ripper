import { query, tx, lockGold, setGold, lockStats, writeStats, readStats, makeId } from './db.js';
import {
	COLLECTION_COLUMNS,
	cardToValues,
	cardFromRow,
	packFromRow,
	openingFromRow,
	valuesClause
} from './rows.js';
import { COLLECTION_VALUE_SQL } from './economySql.js';
import { generatePack, rollSerialized } from './opener.js';
import { pickSerial, serializedFloorUsd } from '../serialized.js';
import { boxSizesFor, productsAvailable } from './collation.js';
import { lastKnownPackEv, packEvUsd, isVintage } from './packvalue.js';
import { PACK_TYPES, packTypeById } from '../packs.js';
import { setEntry } from './registry.js';
import { packPriceUsd as heurPackUsd, boxPriceUsd as heurBoxUsd, sealedPremium } from '../pricing.js';
import { getSealed } from './tcgplayer.js';
import { usdToGold, cardMarketGold, cardSellGold } from '../economy.js';
import { newStats } from './auth.js';

/** How many rip summaries are kept per player. */
const OPENINGS_KEPT = 30;

/**
 * Rows per INSERT when banking a batch of cards. Postgres allows 65535 bound
 * parameters per statement and a card is 13 of them, so the ceiling is about
 * 5,000 rows — a 216-pack case of Play Boosters is roughly 3,000 cards, which is
 * close enough to that limit to not want to discover it in production.
 */
const INSERT_CHUNK = 500;

// ── Reads ──────────────────────────────────────────────────────
export async function getWallet(userId) {
	const { rows } = await query('SELECT gold FROM wallets WHERE user_id = $1', [userId]);
	return rows.length ? { gold: rows[0].gold } : { gold: 0 };
}

export async function getInventory(userId) {
	const { rows } = await query(
		'SELECT * FROM inventory WHERE user_id = $1 ORDER BY acquired_at, id',
		[userId]
	);
	return rows.map(packFromRow);
}

export async function getCollection(userId) {
	const { rows } = await query(
		'SELECT * FROM collections WHERE user_id = $1 ORDER BY acquired_at DESC',
		[userId]
	);
	return rows.map(cardFromRow);
}

export async function getStats(userId) {
	const data = await readStats(userId);
	// A player who has done nothing has no row; the shape still has to be complete,
	// because every consumer reads fields off it directly.
	return { ...newStats(), ...data };
}

export async function getOpenings(userId) {
	const { rows } = await query(
		'SELECT * FROM openings WHERE user_id = $1 ORDER BY at DESC LIMIT $2',
		[userId, OPENINGS_KEPT]
	);
	return rows.map(openingFromRow);
}

/** Number of cards in a collection, without loading any of them. */
export async function collectionCount(userId) {
	const { rows } = await query(
		'SELECT count(*)::int AS n FROM collections WHERE user_id = $1',
		[userId]
	);
	return rows[0].n;
}

/** Number of unopened packs, without loading any of them. */
export async function inventoryCount(userId) {
	const { rows } = await query(
		'SELECT count(*)::int AS n FROM inventory WHERE user_id = $1',
		[userId]
	);
	return rows[0].n;
}

/**
 * Group unopened packs by set + type for the Packs screen.
 *
 * A GROUP BY rather than loading the vault and bucketing it in JS. The ids are
 * still aggregated because the mass-opener sends a specific list back, and that
 * list is what bounds a rip to packs the player actually holds.
 */
export async function inventorySummary(userId) {
	const { rows } = await query(
		`SELECT set_code, pack_type_id, count(*)::int AS count, array_agg(id ORDER BY acquired_at, id) AS ids
		   FROM inventory WHERE user_id = $1
		  GROUP BY set_code, pack_type_id`,
		[userId]
	);

	return rows
		.map((r) => {
			const set = setEntry(r.set_code);
			const type = packTypeById(r.pack_type_id);
			return {
				key: `${r.set_code}:${r.pack_type_id}`,
				setCode: r.set_code,
				setName: set?.name || r.set_code.toUpperCase(),
				packTypeId: r.pack_type_id,
				packName: type?.name || r.pack_type_id,
				accent: type?.accent || 'primary',
				// what one unopened pack sells back for (full current market value)
				sellGold: set ? packPriceGold(set, r.pack_type_id) : 0,
				count: r.count,
				ids: r.ids
			};
		})
		.sort((a, b) => a.setName.localeCompare(b.setName));
}

// ── Pricing (real TCGplayer sealed prices, heuristic fallback) ──
// A pack/box price is the live TCGplayer market price when we have one,
// otherwise the MSRP×vintage estimate from pricing.js.
//
// Everything in this section is synchronous and reads only in-process caches. It
// is deliberately untouched by the move to Postgres: prices are not player data.

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
function evFloor(set, packTypeId) {
	if (!isVintage(set?.released)) return null;
	// Any known EV, however old — see lastKnownPackEv. A stale floor is off by a
	// few percent; a missing one is off by 489x, because the fallback is a $3.99
	// MSRP times an age multiplier.
	const ev = lastKnownPackEv(set.code, packTypeId);
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

/**
 * Make sure the vintage floor for this product exists before money moves.
 *
 * The floors are warmed at startup and by the set's store page, so this is
 * normally a no-op that costs one object lookup. It is here because "normally" is
 * not good enough on a path that charges or pays a player: with a cold floor an
 * Alpha booster is priced at $43 and sells back at $21,179 once anything warms
 * it, and that difference is a money printer. Pricing must not depend on whether
 * a background task has finished.
 *
 * Always called BEFORE opening a transaction, never inside one. It can spend
 * seconds on the network, and a transaction held open across a fetch holds its row
 * locks for exactly that long.
 */
async function ensureVintageFloor(set, packTypeId) {
	if (!isVintage(set?.released)) return;
	if (lastKnownPackEv(set.code, packTypeId) != null) return;
	try {
		await packEvUsd(set.code, packTypeId);
	} catch {
		// No collation or no network. Falls through to the heuristic, which is what
		// the price would have been anyway — but now it is the only option, not a
		// coin flip on cache warmth.
	}
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

/**
 * Ceiling on one purchase, counted in PACKS rather than in units, so "10 boxes"
 * and "360 packs" are held to the same limit.
 *
 * The original reason for this was that every pack was an array element in a blob
 * that got rewritten in full on every mutation, so a fat-fingered order made the
 * whole database unwieldy for everyone. That is no longer true — a pack is a row —
 * but the cap stays, because it is also a sane bound on a single request and on
 * how many packs one mass-open can be asked to roll.
 */
export const MAX_BUY_PACKS = 1080; // five 216-pack cases

/** How many packs one unit of this product is worth. */
function unitPacks(set, packTypeId, kind) {
	return kind === 'box' ? boxSizeFor(set, packTypeId) : 1;
}

/** Largest quantity of this product a purchase may be, for the UI's "Max". */
export function maxBuyQty(set, packTypeId, kind, gold) {
	const unit = kind === 'box' ? boxPriceGold(set, packTypeId) : packPriceGold(set, packTypeId);
	if (!(unit > 0)) return 0;
	const byCap = Math.floor(MAX_BUY_PACKS / unitPacks(set, packTypeId, kind));
	return Math.max(0, Math.min(byCap, Math.floor((gold || 0) / unit)));
}

/**
 * Insert n unopened packs of one product. One statement regardless of n.
 *
 * Exported because the admin panel grants packs too, and a grant and a purchase
 * must put the same rows in the vault.
 */
export async function addPacks(client, userId, setCode, packTypeId, n, now) {
	const ids = Array.from({ length: n }, () => makeId());
	await client.query(
		`INSERT INTO inventory (id, user_id, set_code, pack_type_id, acquired_at)
		 SELECT unnest($1::text[]), $2, $3, $4, $5`,
		[ids, userId, setCode, packTypeId, now]
	);
	return ids;
}

/**
 * Buy `qty` of a product.
 *
 * The balance is locked before it is tested, which is the whole reason this is a
 * transaction: the check and the debit used to be two adjacent synchronous lines
 * that nothing could interleave with, and they are now separated by awaits.
 */
export async function buy(userId, { setCode, packTypeId, kind, qty = 1 }) {
	setCode = String(setCode || '').toLowerCase();
	const set = setEntry(setCode);
	if (!set) return { ok: false, error: 'Unknown set.' };
	if (set.unreleased) return { ok: false, error: 'That set is not released yet.' };
	if (!set.packTypes.includes(packTypeId)) return { ok: false, error: 'That set has no such pack.' };
	const type = packTypeById(packTypeId);
	if (!type) return { ok: false, error: 'Unknown pack type.' };

	const per = unitPacks(set, packTypeId, kind);
	const units = Math.floor(Number(qty) || 0);
	if (units < 1) return { ok: false, error: 'Choose how many to buy.' };
	if (units * per > MAX_BUY_PACKS) {
		return { ok: false, error: `That is over the ${MAX_BUY_PACKS.toLocaleString()}-pack limit for one order.` };
	}

	await ensureVintageFloor(set, packTypeId);
	const unitPrice = kind === 'box' ? boxPriceGold(set, packTypeId) : packPriceGold(set, packTypeId);
	const price = unitPrice * units;
	const added = units * per;

	return tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) return { ok: false, error: 'No wallet.' };
		if (gold < price) return { ok: false, error: 'Not enough gold.' };

		await setGold(client, userId, gold - price);
		await addPacks(client, userId, setCode, packTypeId, added, Date.now());

		const s = await lockStats(client, userId);
		s.goldSpent = (s.goldSpent || 0) + price;
		if (kind === 'box') s.boxesOpened = (s.boxesOpened || 0) + units;
		await writeStats(client, userId, s);

		return { ok: true, added, units, price, gold: gold - price };
	});
}

// ── Opening ────────────────────────────────────────────────────

/**
 * Stamp serial numbers on any serialized cards in a pack, drawing from a global
 * ledger of what has already been issued. A serialized card is a physical object
 * with a finite print run: The One Ring 001/001 can be pulled exactly once, ever,
 * by one player.
 *
 * The ledger is now a table whose primary key is (scryfall_id, n), so the
 * uniqueness is the database's to enforce rather than this function's to be
 * careful about. That changes the shape of the loop: pick a free number, try to
 * claim it, and if the INSERT reports a conflict then somebody else took it
 * between the read and the write — so read again and pick another. Bounded, so a
 * pathological run cannot spin here.
 *
 * Runs inside the caller's transaction, so serials are only ever consumed by a
 * rip that actually gets banked. Rolling back a failed opening puts them back.
 */
async function assignSerials(client, cards) {
	const serialized = cards.filter((c) => c.serialOf && c.serial == null);
	if (!serialized.length) return;
	const now = Date.now();

	for (const c of serialized) {
		let claimed = null;

		for (let attempt = 0; attempt < 25 && claimed == null; attempt++) {
			const { rows } = await client.query('SELECT n FROM serials WHERE scryfall_id = $1', [c.id]);
			const n = pickSerial(
				rows.map((r) => r.n),
				c.serialOf
			);
			if (n == null) break; // whole run claimed

			const { rowCount } = await client.query(
				`INSERT INTO serials (scryfall_id, n, issued_at) VALUES ($1, $2, $3)
				 ON CONFLICT DO NOTHING`,
				[c.id, n, now]
			);
			if (rowCount) claimed = n;
		}

		if (claimed == null) {
			// Whole run claimed — downgrade to the plain foil printing.
			c.serialOf = null;
			c.slot = 'rare';
			c.slotLabel = 'Foil Rare / Mythic';
			c.tier = 6.5;
		} else {
			c.serial = claimed;
			c.valueUsd = Number(serializedFloorUsd(c.serialOf, c.valueUsd).toFixed(2));
		}
	}
}

/**
 * Roll one pack's contents. Pure apart from the network and the caches — it
 * touches no player data, so it runs outside any transaction.
 *
 * `issuedFor` answers "which serials of this card are already out there" for
 * rollSerialized's availability check. It is a snapshot read before rolling
 * began; the authoritative claim happens later, in assignSerials, under the
 * primary key.
 */
async function rollPack(item, issuedFor) {
	const set = setEntry(item.setCode);
	const pack = await generatePack(item.setCode, item.packTypeId, {
		released: set?.released,
		setType: set?.type
	});
	if (!pack || !pack.cards.length) return null;

	// Serialized cards for the sets MTGJSON does not put on a sheet. The six
	// sets that DO model them (BRO/LTR/MOM/MUL/RVR/LTC) already produced theirs
	// through normal collation above.
	const extra = await rollSerialized(item.setCode, item.packTypeId, issuedFor);
	if (extra) pack.cards.push(extra);

	return pack;
}

/** Snapshot of the serial ledger, for rollSerialized's availability check. */
async function issuedLookup() {
	const { rows } = await query('SELECT scryfall_id, n FROM serials');
	const map = new Map();
	for (const r of rows) {
		const list = map.get(r.scryfall_id);
		if (list) list.push(r.n);
		else map.set(r.scryfall_id, [r.n]);
	}
	return (id) => map.get(id) || [];
}

/** Bank a batch of card instances. Chunked; see INSERT_CHUNK. */
async function insertCards(client, userId, cards) {
	const cols = COLLECTION_COLUMNS.join(', ');
	for (let i = 0; i < cards.length; i += INSERT_CHUNK) {
		const batch = cards.slice(i, i + INSERT_CHUNK);
		const params = batch.flatMap((c) => cardToValues(userId, c));
		await client.query(
			`INSERT INTO collections (${cols})
			 VALUES ${valuesClause(batch.length, COLLECTION_COLUMNS.length)}`,
			params
		);
	}
}

/** Fold one pack's contents into a stats object. Mutates `s`. */
function foldPackIntoStats(s, item, pack) {
	s.packsOpened = (s.packsOpened || 0) + 1;
	s.cardsOpened = (s.cardsOpened || 0) + pack.cards.length;
	s.bySet ??= {};
	s.bySet[item.setCode] = (s.bySet[item.setCode] || 0) + 1;

	for (const c of pack.cards) {
		if (c.rarity === 'mythic') s.mythicsPulled = (s.mythicsPulled || 0) + 1;
		else if (c.rarity === 'rare') s.raresPulled = (s.raresPulled || 0) + 1;
		if (c.foil) s.foilsPulled = (s.foilsPulled || 0) + 1;
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
}

/**
 * Bank a batch of rolled packs in one transaction: claim them out of the vault,
 * assign serials, add the cards, fold in the stats, log the rips.
 *
 * The claim comes FIRST, and only packs whose DELETE actually removed a row are
 * banked. That closes a race the old code had: two concurrent opens of the same
 * pack id both found it in the array, both rolled it, and both added their cards
 * while only one of them removed the pack — so one pack produced two packs' worth
 * of cards. The row either deletes or it does not, and only one caller can be the
 * one that deleted it.
 *
 * @param {{item:object, pack:object}[]} opened
 * @returns {Promise<{item:object, pack:object}[]>} the subset actually banked
 */
async function commitOpenings(client, userId, opened, now) {
	const { rows: claimed } = await client.query(
		'DELETE FROM inventory WHERE user_id = $1 AND id = ANY($2::text[]) RETURNING id',
		[userId, opened.map((o) => o.item.id)]
	);
	const gone = new Set(claimed.map((r) => r.id));
	const banked = opened.filter((o) => gone.has(o.item.id));
	if (!banked.length) return banked;

	const cards = [];
	const s = await lockStats(client, userId);

	for (const { item, pack } of banked) {
		// Serials are claimed here rather than at roll time so that a rip which
		// never commits does not consume 137/250 on its way out.
		await assignSerials(client, pack.cards);
		for (const c of pack.cards) {
			c.acquiredAt = now;
			c.sold = false;
			cards.push(c);
		}
		foldPackIntoStats(s, item, pack);
	}

	await insertCards(client, userId, cards);
	await writeStats(client, userId, s);

	const summaries = banked.map(({ item, pack }) => [
		makeId(),
		userId,
		now,
		item.setCode,
		pack.setName ?? null,
		item.packTypeId,
		pack.cards.length,
		pack.cards.reduce((a, c) => a + cardMarketGold(c.valueUsd), 0)
	]);
	await client.query(
		`INSERT INTO openings (id, user_id, at, set_code, set_name, pack_type_id, card_count, value_gold)
		 VALUES ${valuesClause(summaries.length, 8)}`,
		summaries.flat()
	);

	// Keep only the most recent OPENINGS_KEPT. Previously an array slice; now a
	// delete of everything below the cut-off.
	await client.query(
		`DELETE FROM openings
		  WHERE user_id = $1
		    AND id NOT IN (
		        SELECT id FROM openings WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2
		    )`,
		[userId, OPENINGS_KEPT]
	);

	return banked;
}

export async function openPack(userId, inventoryId) {
	const { rows } = inventoryId
		? await query('SELECT * FROM inventory WHERE user_id = $1 AND id = $2', [userId, inventoryId])
		: await query(
				'SELECT * FROM inventory WHERE user_id = $1 ORDER BY acquired_at, id LIMIT 1',
				[userId]
			);
	const item = rows.length ? packFromRow(rows[0]) : null;
	if (!item) return { ok: false, error: 'No pack to open.' };

	const pack = await rollPack(item, await issuedLookup());
	if (!pack) return { ok: false, error: `Card data for ${item.setCode.toUpperCase()} is unavailable.` };

	const banked = await tx((client) => commitOpenings(client, userId, [{ item, pack }], Date.now()));
	if (!banked.length) return { ok: false, error: 'That pack is already open.' };

	return { ok: true, pack, gold: (await getWallet(userId)).gold };
}

/** Hard ceiling on one mass rip — a case of Play Boosters is 216 packs. */
export const MASS_OPEN_MAX = 216;

/**
 * Rip many packs at once. Packs are drawn from the caller's inventory matching
 * `setCode`/`packTypeId` (or from the front of the vault when neither is given),
 * rolled one at a time so collation and pricing caches warm normally, then
 * banked in a single transaction.
 *
 * @param {string} userId
 * @param {{setCode?:string, packTypeId?:string, ids?:string[], count?:number}} opts
 */
export async function openPacks(userId, { setCode, packTypeId, ids, count } = {}) {
	const wanted = Array.isArray(ids) && ids.length;
	const { rows } = wanted
		? await query(
				'SELECT * FROM inventory WHERE user_id = $1 AND id = ANY($2::text[]) ORDER BY acquired_at, id',
				[userId, ids.map(String)]
			)
		: await query(
				`SELECT * FROM inventory
				  WHERE user_id = $1
				    AND ($2::text IS NULL OR set_code = $2)
				    AND ($3::text IS NULL OR pack_type_id = $3)
				  ORDER BY acquired_at, id`,
				[userId, setCode ? String(setCode).toLowerCase() : null, packTypeId || null]
			);

	let queue = rows.map(packFromRow);
	const n = Math.min(queue.length, Math.max(1, Number(count) || queue.length), MASS_OPEN_MAX);
	queue = queue.slice(0, n);
	if (!queue.length) return { ok: false, error: 'No packs to open.' };

	const issuedFor = await issuedLookup();
	const opened = [];
	const failed = [];
	for (const item of queue) {
		let pack = null;
		try {
			pack = await rollPack(item, issuedFor);
		} catch {
			pack = null;
		}
		if (pack) opened.push({ item, pack });
		else failed.push(item.setCode.toUpperCase());
	}
	if (!opened.length) {
		return { ok: false, error: `Card data for ${[...new Set(failed)].join(', ')} is unavailable.` };
	}

	const banked = await tx((client) => commitOpenings(client, userId, opened, Date.now()));
	if (!banked.length) return { ok: false, error: 'Those packs are already open.' };

	const cards = banked.flatMap((o) => o.pack.cards);
	return {
		ok: true,
		packsOpened: banked.length,
		// Packs whose set has no usable card data are left in the vault, not lost.
		skipped: failed.length + (opened.length - banked.length),
		estimated: banked.some((o) => o.pack.estimated),
		cards,
		valueGold: cards.reduce((a, c) => a + cardMarketGold(c.valueUsd), 0),
		gold: (await getWallet(userId)).gold
	};
}

// ── Selling ────────────────────────────────────────────────────
export async function sellCards(userId, uids) {
	const list = [...new Set((uids || []).map(String))];
	if (!list.length) return { ok: true, earned: 0, sold: 0, soldNames: [], gold: (await getWallet(userId)).gold };

	return tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) return { ok: false, error: 'No wallet.' };

		// Scoped by user_id, so a uid guessed from someone else's collection sells
		// nothing. The DELETE is also what makes selling the same card twice
		// impossible — the second one removes no rows and earns nothing.
		const { rows } = await client.query(
			'DELETE FROM collections WHERE user_id = $1 AND uid = ANY($2::text[]) RETURNING name, value_usd',
			[userId, list]
		);

		let earned = 0;
		const soldNames = [];
		for (const r of rows) {
			earned += cardSellGold(r.value_usd);
			soldNames.push(r.name);
		}

		await setGold(client, userId, gold + earned);
		const s = await lockStats(client, userId);
		s.goldEarned = (s.goldEarned || 0) + earned;
		s.cardsSold = (s.cardsSold || 0) + rows.length;
		await writeStats(client, userId, s);

		return { ok: true, earned, sold: rows.length, soldNames, gold: gold + earned };
	});
}

/** Sell unopened packs back to the store at full current market value. */
export async function sellPacks(userId, { setCode, packTypeId, qty = 1 }) {
	setCode = String(setCode || '').toLowerCase();
	const set = setEntry(setCode);
	if (!set) return { ok: false, error: 'Unknown set.' };
	// Buying and selling have to agree about what a pack is worth. If only one of
	// them waits for the floor, the gap between them is free gold.
	await ensureVintageFloor(set, packTypeId);
	const unit = packPriceGold(set, packTypeId);
	const want = Math.max(0, Math.floor(Number(qty) || 0));
	if (!want) return { ok: false, error: 'No matching packs to sell.' };

	return tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) return { ok: false, error: 'No wallet.' };

		const { rowCount: sold } = await client.query(
			`DELETE FROM inventory WHERE id IN (
			   SELECT id FROM inventory
			    WHERE user_id = $1 AND set_code = $2 AND pack_type_id = $3
			    ORDER BY acquired_at, id LIMIT $4
			 )`,
			[userId, setCode, packTypeId, want]
		);
		if (!sold) return { ok: false, error: 'No matching packs to sell.' };

		const earned = unit * sold;
		await setGold(client, userId, gold + earned);
		const s = await lockStats(client, userId);
		s.goldEarned = (s.goldEarned || 0) + earned;
		s.packsSold = (s.packsSold || 0) + sold;
		await writeStats(client, userId, s);

		return { ok: true, sold, earned, gold: gold + earned };
	});
}

/**
 * Value of the whole collection at market, in gold.
 *
 * Summed in the database. This is called on every page load by the layout, and
 * loading a few thousand card rows to add up one number was the single most
 * wasteful thing the old data layer did on a hot path. See economySql.js for why
 * the conversion exists twice and what keeps the two honest.
 */
export async function collectionValue(userId) {
	const { rows } = await query(COLLECTION_VALUE_SQL, [userId]);
	return rows[0].gold;
}
