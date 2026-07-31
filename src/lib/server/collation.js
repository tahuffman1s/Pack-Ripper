/**
 * Builds and caches a per-set "collation slice": everything needed to collate
 * a real pack, and nothing else.
 *
 * An MTGJSON set file is 1-6 MB; the part that describes collation is ~130 KB.
 * A slice is that subtree plus a compact uuid -> card-facts map, merged across
 * every code in `sourceSetCodes` (MKM's Play Booster sheets reference 40 cards
 * that live in PLST.json and 10 in SPG.json).
 *
 * Sheets are classified STRUCTURALLY — by the rarity mix of the cards on them —
 * never by name. Sheet names are not stable across sets ("commonWithShowcase",
 * "common", "commonA"), and any hardcoded list would rot with each release.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSetFile, mtgjsonMeta } from './mtgjson.js';
import { VARIANT_PREFERENCE, isExcludedVariant } from '../packs.js';

const CACHE_DIR = join(process.cwd(), '.cache', 'collation');
const UUID_DIR = join(CACHE_DIR, '_uuid');
const SLICE_TTL_MS = 1000 * 60 * 60 * 24 * 90; // collation never changes for a released set
// Bump when the slice shape changes, so cached slices rebuild instead of
// silently serving a structure the current code no longer matches.
const SLICE_VERSION = 3;

function ensureDirs() {
	if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
	if (!existsSync(UUID_DIR)) mkdirSync(UUID_DIR, { recursive: true });
}

/** Compact per-card facts. Short keys — this map dominates slice size. */
function factOf(card) {
	return {
		s: card.identifiers?.scryfallId || null,
		r: card.rarity || 'common',
		n: card.number || '',
		e: card.setCode || '',
		k: card.name || '',
		c: card.colors || [],
		t: card.type || '',
		// treatments MTGJSON already knows; Scryfall is authoritative but this
		// lets a pack render sensibly even if the Scryfall join misses.
		b: card.borderColor || 'black',
		f: card.frameEffects || [],
		p: card.promoTypes || []
	};
}

function indexCards(cards, into) {
	for (const c of cards || []) into[c.uuid] = factOf(c);
	return into;
}

/** Companion set indexes (PLST, SPG, ...) are written once and shared app-wide. */
async function companionIndex(code) {
	ensureDirs();
	const path = join(UUID_DIR, `${String(code).toUpperCase()}.json`);
	if (existsSync(path)) {
		try {
			return JSON.parse(readFileSync(path, 'utf-8'));
		} catch {
			/* rebuild below */
		}
	}
	const data = await fetchSetFile(code);
	if (!data) return {};
	const idx = indexCards(data.cards, {});
	// tokens can appear on non-playable sheets
	indexCards(data.tokens, idx);
	writeFileSync(path, JSON.stringify(idx));
	return idx;
}

const BASIC_LAND = /^Basic (Snow )?Land/i;

/** Reveal order: build from filler to payoff, the way a pack actually reads. */
const TIER = { land: 0, common: 1, uncommon: 2, wildcard: 3, special: 4, bonus: 5, rare: 6, unknown: 3 };

/** Where a slot of this kind sits in the reveal, foil variants just behind. */
export function slotTier(kind, foil) {
	return (TIER[kind] ?? 3) + (foil ? 0.5 : 0);
}

/**
 * Slot kind of a single card, from its own type and rarity.
 *
 * Used where a sheet is not a rarity slot at all: a `fixed` sheet is a
 * preconstructed deck taken in full, so its cards have to be classified one by
 * one rather than by what the sheet looks like as a whole.
 * @param {{t?:string, r?:string}} fact
 */
export function cardSlotKind(fact) {
	if (BASIC_LAND.test(fact?.t || '')) return 'land';
	const r = fact?.r;
	if (r === 'mythic' || r === 'rare') return 'rare';
	if (r === 'uncommon' || r === 'common') return r;
	return 'wildcard';
}

/**
 * Classify a sheet by what is actually on it.
 * @returns {{kind:string, tier:number, rarityMix:Record<string,number>, foreign:number}}
 */
export function classifySheet(sheet, facts, packSetCode) {
	const uuids = Object.keys(sheet.cards || {});
	if (!uuids.length) return { kind: 'unknown', tier: 3, rarityMix: {}, foreign: 0 };

	const mix = {};
	let basics = 0;
	let foreign = 0;
	let known = 0;

	for (const uuid of uuids) {
		const f = facts[uuid];
		if (!f) continue;
		known++;
		mix[f.r] = (mix[f.r] || 0) + 1;
		if (BASIC_LAND.test(f.t)) basics++;
		if (f.e && packSetCode && f.e.toUpperCase() !== packSetCode.toUpperCase()) foreign++;
	}
	if (!known) return { kind: 'unknown', tier: 3, rarityMix: {}, foreign: 0 };

	const p = (r) => (mix[r] || 0) / known;
	const foreignShare = foreign / known;

	let kind;
	if (basics / known >= 0.8) kind = 'land';
	else if (foreignShare >= 0.9) kind = 'bonus';
	else if (p('mythic') + p('rare') >= 0.95) kind = 'rare';
	else if (p('uncommon') >= 0.9) kind = 'uncommon';
	else if (p('common') >= 0.9) kind = 'common';
	else if (p('special') + p('bonus') >= 0.5) kind = 'special';
	else kind = 'wildcard';

	return { kind, tier: slotTier(kind, sheet.foil), rarityMix: mix, foreign };
}

export function labelFor(kind, foil) {
	const base = {
		land: 'Land',
		common: 'Common',
		uncommon: 'Uncommon',
		rare: 'Rare / Mythic',
		wildcard: 'Wildcard',
		bonus: 'The List / Bonus Sheet',
		special: 'Special',
		unknown: 'Card'
	}[kind] || 'Card';
	return foil ? `Foil ${base}` : base;
}

/**
 * Build the slice for a set. Returns null when MTGJSON has no booster data
 * (13 of PackRipper's 186 eligible sets, all of them bonus sheets, foreign
 * reprints or unreleased — plus any set too new for MTGJSON to have built).
 */
async function buildSlice(code) {
	const data = await fetchSetFile(code);
	if (!data?.booster) return null;

	const setCode = (data.code || code).toUpperCase();

	// Local cards first, then any companion sets the sheets reference.
	const facts = indexCards(data.cards, {});
	indexCards(data.tokens, facts);

	const sourceCodes = new Set();
	for (const variant of Object.values(data.booster)) {
		for (const sc of variant.sourceSetCodes || []) {
			if (sc && sc.toUpperCase() !== setCode) sourceCodes.add(sc.toUpperCase());
		}
	}
	for (const sc of sourceCodes) {
		const idx = await companionIndex(sc);
		for (const [uuid, f] of Object.entries(idx)) if (!facts[uuid]) facts[uuid] = f;
	}

	// Copy the booster subtree, dropping any uuid we cannot resolve and
	// renormalising that sheet's totalWeight so probabilities stay exact.
	const variants = {};
	const usedUuids = new Set();
	let dropped = 0;

	for (const [vName, variant] of Object.entries(data.booster)) {
		const sheets = {};
		for (const [sName, sheet] of Object.entries(variant.sheets || {})) {
			const cards = {};
			let totalWeight = 0;
			for (const [uuid, w] of Object.entries(sheet.cards || {})) {
				if (!facts[uuid]) {
					dropped++;
					continue;
				}
				cards[uuid] = w;
				totalWeight += w;
				usedUuids.add(uuid);
			}
			if (!totalWeight) continue;
			const meta = classifySheet({ cards, foil: sheet.foil }, facts, setCode);
			sheets[sName] = {
				cards,
				totalWeight,
				foil: !!sheet.foil,
				...(sheet.balanceColors ? { balanceColors: true } : {}),
				...(sheet.fixed ? { fixed: true } : {}),
				...(sheet.allowDuplicates ? { allowDuplicates: true } : {}),
				kind: meta.kind,
				tier: meta.tier,
				label: labelFor(meta.kind, sheet.foil)
			};
		}
		if (!Object.keys(sheets).length) continue;

		const boosters = (variant.boosters || [])
			.map((b) => ({
				contents: Object.fromEntries(
					Object.entries(b.contents || {}).filter(([n]) => sheets[n])
				),
				weight: b.weight || 1
			}))
			.filter((b) => Object.keys(b.contents).length);
		if (!boosters.length) continue;

		variants[vName] = {
			boosters,
			boostersTotalWeight: boosters.reduce((a, b) => a + b.weight, 0),
			sheets,
			sourceSetCodes: variant.sourceSetCodes || [setCode]
		};
	}

	if (!Object.keys(variants).length) return null;

	// Keep only the facts the sheets actually reference.
	const trimmed = {};
	for (const uuid of usedUuids) trimmed[uuid] = facts[uuid];

	// The 15th card. Every real modern pack ships a non-playable card — a token,
	// an art card, or (before tokens existed) an ad/tips card. Tokens are not on
	// any booster sheet, so they are carried separately. Sets with no tokens in
	// MTGJSON simply get no such card, which is the correct era behaviour.
	const tokens = (data.tokens || [])
		.filter((t) => t.identifiers?.scryfallId)
		.map((t) => ({ s: t.identifiers.scryfallId, k: t.name, n: t.number || '' }));

	const meta = await mtgjsonMeta();
	return {
		sliceVersion: SLICE_VERSION,
		code: String(code).toLowerCase(),
		setCode,
		name: data.name || setCode,
		released: data.releaseDate || null,
		version: meta?.version || null,
		builtAt: Date.now(),
		variants,
		cards: trimmed,
		tokens,
		dropped,
		// Real sealed-product structure: a Play Booster Box is 36 packs because
		// contents.sealed[0].count says 36, not because a constant says so.
		sealed: (data.sealedProduct || []).map((p) => ({
			name: p.name,
			category: p.category,
			subtype: p.subtype,
			contains: (p.contents?.sealed || []).map((s) => ({ count: s.count, name: s.name }))
		}))
	};
}

/**
 * Probability that a pack of this variant contains a serialized card, computed
 * from the sheets.
 *
 * A non-zero answer means no estimate is needed for this product at all — the
 * collation deals them itself. That is also exactly how opener.js decides whether
 * to layer one on top, so this doubles as the test for "does MTGJSON model
 * serialized cards here". Far more sets say yes than the seven a hardcoded list
 * used to name.
 */
export function serializedRateOf(slice, variantKey) {
	const v = slice?.variants?.[variantKey];
	if (!v) return 0;
	let p = 0;
	for (const cfg of v.boosters) {
		const pc = cfg.weight / v.boostersTotalWeight;
		for (const [name, count] of Object.entries(cfg.contents)) {
			const sheet = v.sheets[name];
			if (!sheet) continue;
			for (const [uuid, w] of Object.entries(sheet.cards)) {
				if ((slice.cards[uuid]?.p || []).includes('serialized')) {
					p += pc * count * (w / sheet.totalWeight);
				}
			}
		}
	}
	return p;
}

const memo = new Map();

/**
 * Box sizes learned from sealed-product data, kept in memory so the store and
 * pricing can read them synchronously once a set's slice has been loaded.
 */
const boxSizes = new Map();

function recordBoxSizes(slice) {
	if (!slice?.sealed) return;
	const sizes = {};
	for (const p of slice.sealed) {
		if (p.category !== 'booster_box' || !p.contains?.length) continue;
		// MTGJSON files some CASES under `booster_box` — "Collector Booster Box
		// Master Case" holds 4 box cases, and Marvel's holds 24 boxes. Counting
		// those as packs-per-box is how a Collector box ends up claiming 24.
		if (/\bcase\b/i.test(p.name || '')) continue;
		// A box can hold more than one kind of thing (a 2XM box is 24 packs PLUS
		// a box topper), so take the entry that is actually a pack. If nothing in
		// it is a pack, this is not a box of packs and is skipped.
		const packEntry = p.contains.find((c) => /booster pack/i.test(c.name || ''));
		const total = packEntry?.count || 0;
		if (total > 0 && p.subtype) sizes[p.subtype] = total;
	}
	// MTGJSON's subtype for pre-Play-Booster sets is `draft`; map `default` too.
	if (sizes.draft && !sizes.default) sizes.default = sizes.draft;
	if (Object.keys(sizes).length) boxSizes.set(slice.code, sizes);
}

/** Packs-per-box by product for a set, or null if not yet known. */
export function boxSizesFor(code) {
	return boxSizes.get(String(code).toLowerCase()) || null;
}

/**
 * Which of our products this set actually shipped with, according to MTGJSON's
 * booster variants. Returns null when the slice has not been loaded, in which
 * case the caller keeps the date-gated guess from catalog.js.
 *
 * This is what stops the store offering a product a set never had — Double
 * Masters gets a Collector Booster from the date rules, but MTGJSON knows it
 * only ever had draft boosters and a VIP Edition.
 */
export function productsAvailable(code) {
	const slice = memo.get(String(code).toLowerCase());
	if (!slice || typeof slice.then === 'function' || !slice.variants) return null;
	const out = [];
	for (const [product, keys] of Object.entries(VARIANT_PREFERENCE)) {
		if (keys.some((k) => slice.variants[k] && !isExcludedVariant(k))) out.push(product);
	}
	return out.length ? out : null;
}

/**
 * Get the collation slice for a set, building and caching it on first use.
 * Cached under .cache/collation/<code>.json — measured ~111 KB mean, ~20 MB
 * for all 173 covered sets if every one is eventually opened.
 */
export async function getCollation(code) {
	code = String(code).toLowerCase();
	if (memo.has(code)) return memo.get(code);

	const path = join(CACHE_DIR, `${code}.json`);
	if (existsSync(path)) {
		try {
			const cached = JSON.parse(readFileSync(path, 'utf-8'));
			if (cached?.sliceVersion === SLICE_VERSION && Date.now() - (cached.builtAt || 0) < SLICE_TTL_MS) {
				recordBoxSizes(cached);
				memo.set(code, cached);
				return cached;
			}
		} catch {
			/* rebuild */
		}
	}

	const p = (async () => {
		let slice = null;
		try {
			slice = await buildSlice(code);
		} catch {
			slice = null;
		}
		if (slice) {
			ensureDirs();
			writeFileSync(path, JSON.stringify(slice));
			recordBoxSizes(slice);
		}
		memo.set(code, slice);
		return slice;
	})();

	memo.set(code, p);
	const result = await p;
	memo.set(code, result);
	return result;
}
