import { makeId } from './db.js';
import { PACK_TYPES, VARIANT_PREFERENCE, isExcludedVariant, eraTemplate, SLOT_LABELS } from '../packs.js';
import { generateFromVariant, makeRng } from '../collate.js';
import { getCollation, cardSlotKind, slotTier, labelFor } from './collation.js';
import { getAllSets, getSetPool, getSetPrints, resolveCardsByIds, poolIsUsable } from './scryfall.js';
import { pickSerial, serializedFloorUsd, serialRunFor, isSerializedCard } from '../serialized.js';
import { observedSerializedStats, modelledInSheets } from './serializedStats.js';
import { nearestCollation, structureOf, pickStructureConfig } from './neighbour.js';
import { treatmentsOf } from '../cards.js';

/**
 * Pack generation.
 *
 * The real path collates from MTGJSON's per-set print sheets: a weighted pick
 * of one of the set's pack configurations, then a weighted draw per sheet.
 * Those weights are the actual print-run multiplicities, so odds, treatment
 * rates and multi-rare packs all fall out of the data rather than constants.
 *
 * The fallback path (era template + Scryfall rarity buckets) runs only when
 * MTGJSON has no booster data for a set — in practice a release too new for
 * MTGJSON's last build. Those packs are stamped `estimated: true`.
 */

function pick(arr, rng) {
	return arr[Math.floor(rng() * arr.length)];
}

/** Choose which MTGJSON variant backs one of our five products. */
export function variantForProduct(slice, packTypeId) {
	if (!slice?.variants) return null;
	for (const key of VARIANT_PREFERENCE[packTypeId] || []) {
		if (slice.variants[key] && !isExcludedVariant(key)) return key;
	}
	return null;
}

function finishFor(sheetFoil, card) {
	if (!sheetFoil) return 'nonfoil';
	const f = card?.finishes || [];
	// Some sheets are foil-only in etched; prefer etched when that is all there is.
	if (f.includes('etched') && !f.includes('foil')) return 'etched';
	return 'foil';
}

function valueOf(card, finish) {
	if (!card) return 0;
	if (finish === 'etched') return card.usdEtched ?? card.usdFoil ?? card.usd ?? 0;
	if (finish === 'foil') return card.usdFoil ?? card.usd ?? 0;
	return card.usd ?? card.usdFoil ?? 0;
}

/**
 * Build a stored card instance. Field names match the previous shape so
 * existing rows in .data/db.json keep rendering; everything new is additive.
 */
function makeInstance(card, { finish, slot, slotLabel, tier, sheet, fromSet, serial, serialOf, estimated }) {
	const foil = finish === 'foil' || finish === 'etched';
	const treatments = treatmentsOf(card);
	let value = valueOf(card, finish);
	if (serialOf) value = serializedFloorUsd(serialOf, value);

	return {
		uid: makeId(),
		id: card.id,
		oracleId: card.oracleId,
		name: card.name,
		set: card.set,
		setName: card.setName,
		number: card.number,
		rarity: card.rarity,
		colors: card.colors,
		manaCost: card.manaCost,
		typeLine: card.typeLine,
		images: card.images,
		scryfallUri: card.scryfallUri,
		foil,
		finish,
		isList: !!fromSet,
		fromSet: fromSet || null,
		treatments,
		slot: slot || null,
		slotLabel: slotLabel || null,
		tier: tier ?? 1,
		sheet: sheet || null,
		serial: serial ?? null,
		serialOf: serialOf ?? null,
		estimated: !!estimated,
		valueUsd: Number((value || 0).toFixed(2))
	};
}

/**
 * Lay the pack out the way a real one is stacked.
 *
 * A collation study of Murders at Karlov Manor Play Boosters documents the
 * physical order, front-facing:
 *
 *   art card / token → basic land → List or Special Guest (if present)
 *   → the guaranteed foil → 1-2 rares → 3-4 uncommons → 6-8 commons
 *
 * Two consequences worth noting. Cards group by RARITY, not by slot: a wildcard
 * that rolls uncommon physically sits among the uncommons, not in some separate
 * "wildcard" position. And the commons are at the far end of the stack.
 *
 * When you actually rip a pack the cards come out face-down and you flip the
 * stack, which reverses it — so what you SEE is commons first, building through
 * uncommons and rares to the foil, then the bonus card, land and token at the
 * end. That is what this returns. Set REVEAL_FROM_FRONT to read the stack the
 * other way instead.
 */
const REVEAL_FROM_FRONT = false;

const STACK = {
	nonplayable: 0,
	land: 1,
	bonus: 2,
	foil: 3, // the single guaranteed foil, ahead of the rares
	rare: 6,
	uncommon: 8,
	common: 10
};

/**
 * Where a card sits in the physical stack, front (0) to back.
 *
 * `soloFoil` is the Play/Draft/Set case, where the pack contains one guaranteed
 * foil that occupies its own position regardless of what rarity it rolled. That
 * rule cannot apply to a Collector Booster, where nearly every card is foil —
 * there the stack runs by rarity, with the foil of a rarity sitting behind its
 * non-foil counterpart. (The MKM study covers Play Boosters; the Collector
 * arrangement is the consistent extension of it, not a separately sourced fact.)
 */
function stackPosition(card, soloFoil) {
	if (card.slot === 'nonplayable') return STACK.nonplayable;
	// A basic land sits in the land position wherever it was drawn from — some
	// sets put the basic on the common sheet rather than a dedicated land sheet.
	if (card.slot === 'land' || /^Basic (Snow )?Land/i.test(card.typeLine || '')) return STACK.land;
	if (card.slot === 'bonus' || card.fromSet) return STACK.bonus;
	// Serialized cards ride in the Booster Fun foil slot — the deepest card.
	if (card.slot === 'serialized') return STACK.foil;
	if (soloFoil && card.foil) return STACK.foil;

	const base =
		card.rarity === 'rare' || card.rarity === 'mythic'
			? STACK.rare
			: card.rarity === 'uncommon'
				? STACK.uncommon
				: STACK.common;
	// Within a rarity, the foil sits behind the non-foils.
	return base - (card.foil ? 1 : 0);
}

function sortForReveal(cards) {
	const foils = cards.filter((c) => c.foil && c.slot !== 'land').length;
	const soloFoil = foils <= 2;
	const dir = REVEAL_FROM_FRONT ? 1 : -1;
	return cards
		.map((c, i) => ({ c, i, p: stackPosition(c, soloFoil) }))
		.sort((a, b) => (a.p - b.p) * dir || a.i - b.i) // draw order within a group, as in a real pack
		.map((x) => x.c);
}

// ── The real path ──────────────────────────────────────────────

async function resolvePrints(picked, slice) {
	const packSet = slice.setCode.toLowerCase();
	const local = [];
	const foreign = [];
	for (const p of picked) {
		const fact = slice.cards[p.uuid];
		if (!fact?.s) continue;
		((fact.e || '').toLowerCase() === packSet ? local : foreign).push(fact.s);
	}

	const index = local.length ? await getSetPrints(packSet) : {};
	// Anything the set crawl missed, plus every companion-set card, resolves
	// individually and is cached by id.
	const stillMissing = [...foreign, ...local.filter((id) => !index[id])];
	const extra = stillMissing.length ? await resolveCardsByIds(stillMissing) : {};
	return { ...index, ...extra };
}

async function generateFromCollation(slice, packTypeId, rng) {
	const variantKey = variantForProduct(slice, packTypeId);
	if (!variantKey) return null;
	const variant = slice.variants[variantKey];

	const { picked } = generateFromVariant(variant, { rng, facts: slice.cards });
	if (!picked.length) return null;

	const prints = await resolvePrints(picked, slice);
	const packSet = slice.setCode.toLowerCase();
	const cards = [];

	for (const p of picked) {
		const fact = slice.cards[p.uuid];
		if (!fact) continue;
		const sheet = variant.sheets[p.sheet];
		let card = fact.s ? prints[fact.s] : null;

		// Join failure: fall back to what MTGJSON itself knows about the card so
		// the slot is still filled with the right card, just without art.
		if (!card) {
			card = {
				id: fact.s || `mtgjson-${p.uuid}`,
				oracleId: null,
				name: fact.k,
				set: (fact.e || packSet).toLowerCase(),
				setName: fact.e || slice.name,
				number: fact.n,
				rarity: fact.r,
				colors: fact.c || [],
				manaCost: '',
				typeLine: fact.t || '',
				images: null,
				usd: null,
				usdFoil: null,
				usdEtched: null,
				finishes: p.foil ? ['foil'] : ['nonfoil'],
				frameEffects: fact.f || [],
				promoTypes: fact.p || [],
				borderColor: fact.b || 'black',
				fullArt: false,
				scryfallUri: null
			};
		}

		const isForeign = (fact.e || '').toLowerCase() !== packSet;
		// Six sets put serialized cards on real sheets, so they arrive here at
		// exactly the published rate. The serial NUMBER is assigned later by
		// game.js, which owns the issued-serial ledger.
		const serialized = isSerializedCard(card) || (fact.p || []).includes('serialized');
		const serialOf = serialized
			? serialRunFor(fact.e || packSet, card, sheet?.cards?.[p.uuid] ?? 0)
			: null;

		// Some sets carry the basic on the common sheet; it is still the land slot.
		const isBasic = /^Basic (Snow )?Land/i.test(card.typeLine || fact.t || '');
		// A `fixed` sheet is a preconstructed deck rather than a rarity slot, so the
		// sheet's own classification says nothing useful about any one card on it:
		// every card in a Jumpstart theme deck would otherwise read "Wildcard".
		// Take the slot from the card itself, so the pack reads by rarity.
		const kind = serialized
			? 'serialized'
			: isBasic
				? 'land'
				: sheet?.fixed
					? cardSlotKind(fact)
					: sheet?.kind || 'unknown';

		cards.push(
			makeInstance(card, {
				finish: finishFor(p.foil, card),
				slot: kind,
				slotLabel: serialized
					? 'Serialized'
					: isBasic
						? p.foil
							? 'Foil Land'
							: 'Land'
						: sheet?.fixed
							? labelFor(kind, p.foil)
							: sheet?.label || 'Card',
				tier: serialized ? 9 : sheet?.fixed ? slotTier(kind, p.foil) : sheet?.tier ?? 1,
				sheet: p.sheet,
				fromSet: isForeign ? fact.e : null,
				serialOf,
				estimated: false
			})
		);
	}

	// A Jumpstart pack is a twenty-card deck plus the card that names the theme —
	// not twenty cards plus a token, which is a 21-card pack containing something
	// no Jumpstart booster has ever held.
	if (packTypeId === 'jumpstart') {
		const front = await drawFrontCard(slice, themeKeysOf(picked, variant));
		if (front) cards.push(front);
	} else if (packTypeId !== 'collector' && packTypeId !== 'mystery') {
		// Collector Boosters are all premium cards, and a Mystery Booster is exactly
		// one card from each of its print sheets — neither carries a token or ad card.
		const extra = await drawNonPlayable(slice, packTypeId, rng);
		if (extra) cards.push(extra);
	}

	return {
		packTypeId,
		setCode: slice.code,
		setName: slice.name,
		variant: variantKey,
		estimated: false,
		source: 'mtgjson',
		cards
	};
}

/**
 * The theme a Jumpstart pack was built from, read off its sheet names.
 *
 * MTGJSON names a Jumpstart deck's sheet after the theme in camelCase, adding a
 * variant number when a theme has more than one deck and a `Foils` suffix for
 * the deck's foil basics: `aboveTheClouds1`, `arcaneMischief`,
 * `arcaneMischiefFoils`. Stripping those leaves the theme itself.
 */
function themeKeysOf(picked, variant) {
	const keys = [];
	for (const name of new Set(picked.map((p) => p.sheet))) {
		if (!variant.sheets[name]?.fixed) continue;
		keys.push(name.replace(/Foils?$/, '').replace(/\d+$/, ''));
	}
	return keys;
}

/** Compare theme names ignoring case and punctuation: treeHugging = Tree-Hugging. */
function themeKey(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

/**
 * The set holding a Jumpstart release's front cards, or null.
 *
 * Wizards prints one front card per theme, and Scryfall files them in a
 * companion set named "<set> Jumpstart Front Cards" — or "<set> Front Cards"
 * when the Jumpstart release stands alone, so "Jumpstart 2022" pairs with
 * "Jumpstart 2022 Front Cards". That naming is the same fingerprint catalog.js
 * reads to decide which sets sold Jumpstart Boosters in the first place.
 */
async function frontCardSetCode(slice) {
	let sets;
	try {
		sets = await getAllSets();
	} catch {
		return null;
	}
	const want = new Set([
		`${slice.name} front cards`.toLowerCase(),
		`${slice.name} jumpstart front cards`.toLowerCase()
	]);
	const hit = (sets || []).find((s) => want.has(String(s.name || '').toLowerCase()));
	return hit?.code || null;
}

/**
 * The themed front card a Jumpstart pack ships with, in place of the token every
 * other product carries. Names match the sheet name once case and punctuation
 * are dropped (`treeHugging1` -> "Tree-Hugging"), so no lookup table is needed.
 * Returns null when the release has no front-card set — then the pack is simply
 * its twenty cards, which is still right.
 */
async function drawFrontCard(slice, keys) {
	if (!keys.length) return null;
	const code = await frontCardSetCode(slice);
	if (!code) return null;

	let prints;
	try {
		prints = await getSetPrints(code);
	} catch {
		return null;
	}
	const byTheme = new Map();
	for (const c of Object.values(prints || {})) byTheme.set(themeKey(c.name), c);

	for (const k of keys) {
		const card = byTheme.get(themeKey(k));
		if (!card) continue;
		return makeInstance(
			// A front card is not a game card and carries no rarity of its own;
			// labelling it "Common" would misreport the pack.
			{ ...card, rarity: 'front' },
			{
				finish: 'nonfoil',
				slot: 'nonplayable',
				slotLabel: 'Front Card',
				tier: 0,
				sheet: null,
				estimated: false
			}
		);
	}
	return null;
}

/**
 * The non-playable card every real pack ships with — a token or art card.
 * It is not on any booster sheet, so it is drawn from the set's token list.
 * Sets with no tokens (everything before they existed) correctly get nothing.
 */
async function drawNonPlayable(slice, packTypeId, rng) {
	// Set Boosters famously end on an ART CARD rather than a token. Scryfall
	// publishes each set's art series under the code "a" + set code.
	if (packTypeId === 'set') {
		const art = await drawArtCard(slice.code, rng);
		if (art) return art;
	}

	const tokens = slice.tokens || [];
	if (!tokens.length) return null;
	const t = pick(tokens, rng);
	if (!t?.s) return null;

	const resolved = await resolveCardsByIds([t.s]);
	const card = resolved[t.s];
	if (!card) return null;

	return asNonPlayable(card);
}

/**
 * One card from a set's art series. Wizards gold-stamps a signed version of
 * roughly 1 in 20 art cards; that rate is a Set Booster published figure.
 */
async function drawArtCard(code, rng) {
	let prints;
	try {
		prints = await getSetPrints(`a${code}`);
	} catch {
		return null;
	}
	const list = Object.values(prints || {});
	if (!list.length) return null;
	const card = pick(list, rng);
	return card ? asNonPlayable(card) : null;
}

function asNonPlayable(card) {
	const isArt = /art (card|series)/i.test(card.typeLine || '') || card.set?.startsWith('a');
	return makeInstance(
		// Tokens carry a rarity on Scryfall but are not a rarity slot — labelling
		// one "Common" would misreport the pack.
		{ ...card, rarity: isArt ? 'art' : 'token' },
		{
			finish: 'nonfoil',
			slot: 'nonplayable',
			slotLabel: isArt ? 'Art Card' : 'Token',
			tier: 0,
			sheet: null,
			estimated: false
		}
	);
}

// ── The fallback path ──────────────────────────────────────────

/**
 * Products whose packs hold only plain printings.
 *
 * A Jumpstart deck is a preconstructed list of ordinary cards. Across all seven
 * Jumpstart products MTGJSON has sheets for — JMP, J22, J25 and the DMU, BRO,
 * ONE and MOM companion boosters — not one non-land card on any theme-deck sheet
 * carries a treatment: no borderless, no showcase, no extended art, none. Only
 * the basics ever do (full-art in DMU and MOM, showcase in ONE).
 *
 * Wizards' published contents say the same thing. The Brothers' War Jumpstart
 * Booster is listed as two rares, eight non-land cards and "6 Non-foil lands, 2
 * Traditional foil lands", with no Booster Fun in the list at all; Avatar's
 * collecting article puts that set's borderless and neon-ink printings in
 * Collector Boosters only.
 *
 * This matters for value, not just looks. A substituted pool contains every
 * printing in the set, and borderless mythics are worth many times the plain
 * card — which is how a $3.99 Avatar Jumpstart pack came to hold $12 of singles.
 */
const PLAIN_PRINTINGS_ONLY = new Set(['jumpstart']);

function poolFor(cards, kind) {
	const order = {
		rare: ['rare', 'mythic', 'uncommon', 'common'],
		mythic: ['mythic', 'rare', 'uncommon', 'common'],
		uncommon: ['uncommon', 'common', 'rare'],
		common: ['common', 'uncommon', 'land'],
		land: ['land', 'common'],
		wildcard: ['common', 'uncommon', 'rare'],
		bonus: ['rare', 'uncommon', 'common']
	};
	for (const key of order[kind] || [kind]) {
		if (cards[key]?.length) return cards[key];
	}
	for (const key of Object.keys(cards)) if (cards[key]?.length) return cards[key];
	return [];
}

/**
 * Fallback pack, for sets with no MTGJSON collation.
 *
 * The slot structure is BORROWED from the nearest set that does have real
 * collation — same product, same set type, closest release — so a brand-new
 * expansion gets the actual current pack layout rather than a guess. Only the
 * card pool is substituted. If even that is unavailable (no comparable set at
 * all) it drops to a dated era template as a last resort.
 *
 * Treatments are gated by release date either way, so a 1997 set can never
 * produce a borderless card.
 */
export async function generateFallbackPack(setCode, packTypeId, released, rng = Math.random, setType) {
	const pool = await getSetPool(setCode);
	if (!poolIsUsable(pool)) return null;


	const relStr = released || pool.released;
	const relMs = relStr ? Date.parse(relStr) : Date.now();
	const allowTreatments = relMs >= Date.parse('2019-10-04'); // Throne of Eldraine
	const plainOnly = PLAIN_PRINTINGS_ONLY.has(packTypeId);

	// Prefer a real structure from a comparable set.
	let slots = null;
	let borrowedFrom = null;
	try {
		const near = await nearestCollation(setCode, packTypeId, relStr, setType);
		if (near) {
			const structure = structureOf(near.slice, near.variantKey);
			if (structure?.configs?.length) {
				slots = pickStructureConfig(structure, rng).slots;
				borrowedFrom = near.from;
			}
		}
	} catch {
		slots = null;
	}

	// Last resort: a dated template.
	if (!slots) {
		const tpl = eraTemplate(relStr, packTypeId);
		const TIER = { land: 0, common: 1, uncommon: 2, wildcard: 3, bonus: 5, rare: 6 };
		slots = tpl.slots.map((s) => ({
			kind: s.kind,
			label: (s.foil ? 'Foil ' : '') + (SLOT_LABELS[s.kind] || 'Card'),
			tier: (TIER[s.kind] ?? 1) + (s.foil ? 0.5 : 0),
			// Some templates make a slot foil outright — a Jumpstart deck's two
			// traditional foil lands are always foil, not a foil chance.
			foil: !!s.foil,
			count: s.count,
			mythicShare: s.kind === 'rare' ? tpl.mythicChance : 0
		}));
		// Spread the era's foil rate over one slot, as a foil replacing a card.
		if (tpl.foilChance > 0 && rng() < tpl.foilChance) {
			const target = slots.find((s) => s.kind === 'common') || slots[0];
			if (target) target.foilOne = true;
		}
	}

	const cards = [];
	// Pack-wide, unlike the MTGJSON path. There the per-sheet dedupe is the
	// physically correct rule; here the pool is a flat rarity bucket with no
	// sheet structure, and a thin pool (a set with only a few previewed cards)
	// would otherwise return the same common eight times.
	const used = new Set();

	for (const slot of slots) {
		// A land slot of more than one card is a preconstructed deck's mana base,
		// and a real Jumpstart half-deck runs seven copies of ONE basic — every one
		// of the DMU/BRO/ONE/MOM theme decks uses a single basic. Drawing seven
		// distinct basics instead would be a deck nobody could play, so the basic
		// is chosen once and repeated, and stays out of the pack-wide dedupe.
		if (slot.kind === 'land' && slot.count > 1) {
			const basics = poolFor(pool.cards, 'land');
			if (!basics.length) continue;
			const basic = pick(basics, rng);
			for (let i = 0; i < slot.count; i++) {
				cards.push(
					makeInstance(basic, {
						finish: slot.foil ? finishFor(true, basic) : 'nonfoil',
						slot: 'land',
						slotLabel: slot.label || SLOT_LABELS.land,
						tier: slot.tier ?? 0,
						sheet: null,
						estimated: true
					})
				);
			}
			continue;
		}

		for (let i = 0; i < slot.count; i++) {
			let kind = slot.kind;
			if (kind === 'rare') kind = rng() < (slot.mythicShare || 0) ? 'mythic' : 'rare';
			else if (kind === 'wildcard' || kind === 'bonus' || kind === 'special') {
				// Without the donor set's own sheet contents, a wildcard slot
				// resolves over this set's rarity buckets proportionally.
				const r = rng();
				kind = r < 0.6 ? 'common' : r < 0.87 ? 'uncommon' : r < 0.98 ? 'rare' : 'mythic';
			}

			let candidates = poolFor(pool.cards, kind);
			// Basics are exempt: a full-art or showcase basic is the ordinary
			// printing of a land in the sets that have one, and real Jumpstart
			// decks use them.
			if (plainOnly && kind !== 'land') {
				const plain = candidates.filter((c) => !treatmentsOf(c).length);
				if (plain.length) candidates = plain;
			}
			if (!allowTreatments) {
				const plain = candidates.filter(
					(c) => (c.borderColor || 'black') === 'black' && !(c.frameEffects || []).length
				);
				if (plain.length) candidates = plain;
			}
			if (!candidates.length) continue;

			// Prefer an unused card; fall back to any only if the bucket is
			// genuinely exhausted.
			const fresh = candidates.filter((c) => !used.has(c.id));
			const card = pick(fresh.length ? fresh : candidates, rng);
			used.add(card.id);

			const foil = slot.foil || (slot.foilOne && i === 0);
			cards.push(
				makeInstance(card, {
					finish: foil ? finishFor(true, card) : 'nonfoil',
					slot: slot.kind,
					slotLabel: slot.label || SLOT_LABELS[slot.kind] || 'Card',
					tier: slot.tier ?? 1,
					sheet: null,
					estimated: true
				})
			);
		}
	}

	if (!cards.length) return null;

	// A set still mid-spoiler can have a dozen cards on Scryfall but only one
	// common, which fills eight slots with the same card. Real packs never look
	// like that, so refuse rather than render something obviously broken — the
	// caller surfaces "card data unavailable". Basic lands are excluded from the
	// check: a Jumpstart deck's seven copies of one Island are the real product,
	// and counting them as repeats rejected every Jumpstart pack built this way.
	const spells = cards.filter((c) => c.slot !== 'land');
	const distinct = new Set(spells.map((c) => c.id)).size;
	if (distinct < Math.ceil(spells.length * 0.75)) return null;

	return {
		packTypeId,
		setCode: String(setCode).toLowerCase(),
		setName: pool.name,
		variant: null,
		estimated: true,
		source: borrowedFrom ? `structure:${borrowedFrom}` : 'era-template',
		borrowedFrom,
		cards
	};
}

// ── Entry point ────────────────────────────────────────────────

/**
 * Build one pack.
 * @param {string} setCode
 * @param {string} packTypeId
 * @param {{seed?:number, released?:string}} [opts]
 */
export async function generatePack(setCode, packTypeId, opts = {}) {
	if (!PACK_TYPES[packTypeId]) throw new Error('Unknown pack type: ' + packTypeId);
	const rng = opts.seed != null ? makeRng(opts.seed) : Math.random;
	setCode = String(setCode).toLowerCase();

	let pack = null;
	try {
		const slice = await getCollation(setCode);
		if (slice) pack = await generateFromCollation(slice, packTypeId, rng);
	} catch {
		pack = null;
	}

	if (!pack) pack = await generateFallbackPack(setCode, packTypeId, opts.released, rng, opts.setType);
	if (!pack) return null;

	pack.cards = sortForReveal(pack.cards);
	return pack;
}

/**
 * Serialized cards for sets MTGJSON does not put on a sheet.
 *
 * Which cards exist comes from Scryfall (`promo_types` contains "serialized").
 * How often they appear, and how long the print run is, come from the median of
 * the sets MTGJSON DOES model — no set list and no probability is written here.
 * Wizards states serialized pulls are "infrequent enough that they do not impact
 * the drop rates for other treatments", which is explicit licence to layer them
 * on top rather than fold them into the published slot percentages.
 *
 * Called by game.js, which owns the issued-serial ledger.
 */
export async function rollSerialized(setCode, packTypeId, issuedFor, rng = Math.random) {
	const code = String(setCode).toLowerCase();
	// Sets MTGJSON models already produced their serialized cards in collation.
	if (modelledInSheets(code)) return null;
	// Serialized cards have only ever ridden in Collector Boosters.
	if (packTypeId !== 'collector') return null;

	const prints = await getSetPrints(code);
	const candidates = Object.values(prints).filter(isSerializedCard);
	if (!candidates.length) return null; // Scryfall says this set has none

	const stats = await observedSerializedStats();
	if (rng() >= stats.rate) return null;

	const card = pick(candidates, rng);
	const of = serialRunFor(code, card, 0, stats.run);
	const serial = pickSerial(issuedFor(card.id), of, rng);
	if (serial == null) return null; // the whole print run is claimed

	return makeInstance(card, {
		finish: (card.finishes || []).includes('etched') ? 'etched' : 'foil',
		slot: 'serialized',
		slotLabel: 'Serialized',
		tier: 9,
		sheet: null,
		serial,
		serialOf: of,
		estimated: true
	});
}
