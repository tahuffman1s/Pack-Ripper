/**
 * Pure booster collation sampler.
 *
 * Operates on an MTGJSON `BoosterConfig` ("variant"): a set of weighted pack
 * configurations plus named sheets of cards with per-card integer weights.
 * Those weights are reverse-engineered print-sheet multiplicities, so a common
 * printed twice on a sheet really is twice as likely as one printed once.
 *
 * No fs, no fetch, no globals — everything comes in through `ctx` so the whole
 * thing is unit-testable and reproducible with a seeded RNG.
 *
 *   variant = {
 *     boosters: [{ contents: { sheetName: pickCount }, weight }],
 *     boostersTotalWeight: number,
 *     sheets: { name: { cards: {uuid: weight}, totalWeight, foil,
 *                       balanceColors?, fixed?, allowDuplicates? } }
 *   }
 *
 * NOTE on `contents`: MTGJSON's docs call these values "the weight". They are
 * not — they are pick counts. An MKM play config's contents sum to 14, which is
 * exactly the printed card count of a Play Booster.
 */

const WUBRG = ['W', 'U', 'B', 'R', 'G'];

/** Deterministic, seedable PRNG (mulberry32). */
export function makeRng(seed) {
	let a = (seed >>> 0) || 0x9e3779b9;
	return function rng() {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Cache Object.entries per sheet; sheets are hot and immutable. */
function entriesOf(sheet) {
	if (!sheet.__entries) {
		Object.defineProperty(sheet, '__entries', {
			value: Object.entries(sheet.cards),
			enumerable: false
		});
	}
	return sheet.__entries;
}

/**
 * Weighted draw from a sheet, excluding `rejected`.
 *
 * This is exact weighted sampling *without replacement*: the rejected cards'
 * weights are subtracted from the total rather than redrawn-and-hoped. The
 * common alternative (try 3 times, then give up and return null) silently
 * produces short packs — measured at 11 in 200,000 MKM Play Boosters and 88 in
 * 50,000 Arabian Nights packs. A corpus-wide scan of all 3,610 sheets found no
 * sheet where picks exceed distinct cards, so a draw is always possible.
 */
export function weightedPick(sheet, rng, rejected) {
	const entries = entriesOf(sheet);
	let total = sheet.totalWeight;
	if (rejected && rejected.size) {
		for (const uuid of rejected) total -= sheet.cards[uuid] || 0;
	}
	if (!(total > 0)) return null;

	let r = rng() * total;
	let last = null;
	for (let i = 0; i < entries.length; i++) {
		const uuid = entries[i][0];
		if (rejected && rejected.has(uuid)) continue;
		last = uuid;
		r -= entries[i][1];
		if (r < 0) return uuid;
	}
	// Floating-point slack at the tail: fall back to the last eligible card.
	return last;
}

/** Cards on this sheet whose colour identity is exactly the given colour. */
function monoColored(sheet, facts, color) {
	const out = [];
	for (const [uuid, w] of entriesOf(sheet)) {
		const c = facts?.[uuid]?.c;
		if (c && c.length === 1 && c[0] === color) out.push([uuid, w]);
	}
	return out;
}

function pickFromEntries(entries, rng, rejected) {
	let total = 0;
	for (const [uuid, w] of entries) if (!rejected.has(uuid)) total += w;
	if (!(total > 0)) return null;
	let r = rng() * total;
	let last = null;
	for (const [uuid, w] of entries) {
		if (rejected.has(uuid)) continue;
		last = uuid;
		r -= w;
		if (r < 0) return uuid;
	}
	return last;
}

/**
 * Draw `count` cards from a sheet.
 *
 * Duplicate suppression is scoped to THIS SLOT ONLY and never across slots.
 * Deduping across slots measurably moves the odds — with 6-7 commons drawn
 * first, the reject set fills with commons and the later wildcard rerolls land
 * disproportionately on non-commons (MKM rare as-fan 1.4521 -> 1.4745). It is
 * also physically wrong: a real Play Booster can absolutely contain a nonfoil
 * common and the traditional foil of that same card.
 */
export function drawPlain(sheet, count, rng) {
	const picked = [];
	const rejected = new Set();
	const dedupe = !sheet.allowDuplicates;
	for (let i = 0; i < count; i++) {
		const uuid = weightedPick(sheet, rng, dedupe ? rejected : null);
		if (uuid == null) break;
		picked.push(uuid);
		if (dedupe) rejected.add(uuid);
	}
	return picked;
}

/**
 * Colour-balanced draw, for sheets MTGJSON flags `balanceColors`.
 *
 * Takes one mono-coloured card of each of WUBRG first, then fills the rest
 * normally. Only applied when the sheet actually declares the flag — no set
 * with a Play Booster variant declares it (the newest flagged set is RVR,
 * 2024-01-12), and forcing it on modern packs would distort visible
 * composition on the strength of a community heuristic rather than data.
 */
export function drawColorBalanced(sheet, count, rng, facts) {
	if (count < WUBRG.length) return drawPlain(sheet, count, rng);

	const picked = [];
	const rejected = new Set();
	const dedupe = !sheet.allowDuplicates;

	for (const color of WUBRG) {
		const pool = monoColored(sheet, facts, color);
		if (!pool.length) continue;
		const uuid = pickFromEntries(pool, rng, rejected);
		if (uuid == null) continue;
		picked.push(uuid);
		if (dedupe) rejected.add(uuid);
	}

	while (picked.length < count) {
		const uuid = weightedPick(sheet, rng, dedupe ? rejected : null);
		if (uuid == null) break;
		picked.push(uuid);
		if (dedupe) rejected.add(uuid);
	}

	// Shuffle so the WUBRG seeding order is not visible in the reveal.
	for (let i = picked.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[picked[i], picked[j]] = [picked[j], picked[i]];
	}
	return picked;
}

/** A `fixed` sheet is taken in full, each card repeated `weight` times. */
function drawFixed(sheet) {
	const out = [];
	for (const [uuid, w] of entriesOf(sheet)) {
		for (let i = 0; i < w; i++) out.push(uuid);
	}
	return out;
}

/** Choose one of the variant's weighted pack configurations. */
export function pickConfig(variant, rng) {
	const total =
		variant.boostersTotalWeight ||
		variant.boosters.reduce((a, b) => a + (b.weight || 1), 0);
	let r = rng() * total;
	for (let i = 0; i < variant.boosters.length; i++) {
		r -= variant.boosters[i].weight || 1;
		if (r < 0) return i;
	}
	return variant.boosters.length - 1;
}

/**
 * Generate one pack.
 * @returns {{configIndex:number, picked:{uuid:string,sheet:string,foil:boolean}[]}}
 */
export function generateFromVariant(variant, { rng = Math.random, facts = null } = {}) {
	const configIndex = pickConfig(variant, rng);
	const config = variant.boosters[configIndex];
	const picked = [];

	for (const [sheetName, count] of Object.entries(config.contents || {})) {
		const sheet = variant.sheets?.[sheetName];
		if (!sheet || !sheet.totalWeight) continue;

		let uuids;
		if (sheet.fixed) uuids = drawFixed(sheet);
		else if (sheet.balanceColors) uuids = drawColorBalanced(sheet, count, rng, facts);
		else uuids = drawPlain(sheet, count, rng);

		for (const uuid of uuids) {
			picked.push({ uuid, sheet: sheetName, foil: !!sheet.foil });
		}
	}

	return { configIndex, picked };
}

/**
 * Marginal probability that a given sheet contributes at least one card,
 * and the expected number of cards it contributes. Used by the odds harness
 * and by the "published odds" panel.
 */
export function sheetMarginals(variant) {
	const total =
		variant.boostersTotalWeight ||
		variant.boosters.reduce((a, b) => a + (b.weight || 1), 0);
	const out = {};
	for (const cfg of variant.boosters) {
		const p = (cfg.weight || 1) / total;
		for (const [name, n] of Object.entries(cfg.contents || {})) {
			out[name] ??= { p: 0, asFan: 0 };
			out[name].p += p;
			out[name].asFan += p * n;
		}
	}
	return out;
}

/**
 * Expected number of cards of each rarity per pack ("as-fan"), computed
 * analytically from the weights rather than by sampling.
 */
export function rarityAsFan(variant, facts) {
	const total =
		variant.boostersTotalWeight ||
		variant.boosters.reduce((a, b) => a + (b.weight || 1), 0);
	const out = {};
	for (const cfg of variant.boosters) {
		const pCfg = (cfg.weight || 1) / total;
		for (const [name, n] of Object.entries(cfg.contents || {})) {
			const sheet = variant.sheets?.[name];
			if (!sheet?.totalWeight) continue;
			for (const [uuid, w] of entriesOf(sheet)) {
				const rarity = facts?.[uuid]?.r || 'unknown';
				out[rarity] = (out[rarity] || 0) + pCfg * n * (w / sheet.totalWeight);
			}
		}
	}
	return out;
}
