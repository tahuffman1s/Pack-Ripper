/**
 * What a pack is actually worth, computed from its real print sheets.
 *
 * The MSRP-times-age heuristic in pricing.js is fine for product that is still
 * in print, but it is badly wrong for vintage sealed: it prices an Alpha booster
 * at $43 when the singles inside average into the thousands. Nobody sells a pack
 * for less than the cards in it.
 *
 * Now that collation is real, the expected value is exactly computable — for
 * every sheet a pack draws from, sum each card's price weighted by its share of
 * that sheet, times how many cards the pack takes from it. No sampling.
 *
 * This is used as a FLOOR on the pack price, not as the price. Modern packs are
 * deliberately negative-EV (that is how the business works), so the floor never
 * binds for them; it only rescues vintage product the heuristic underprices.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCollation } from './collation.js';
import { getSetPrints, resolveCardsByIds } from './scryfall.js';
import { variantForProduct } from './opener.js';

const CACHE_DIR = join(process.cwd(), '.cache', 'collation');
const EV_CACHE = join(CACHE_DIR, '_ev.json');
const TTL_MS = 1000 * 60 * 60 * 24 * 14; // tracks card prices, so same TTL as those

let memo = null;
function store() {
	if (memo) return memo;
	try {
		memo = existsSync(EV_CACHE) ? JSON.parse(readFileSync(EV_CACHE, 'utf-8')) : {};
	} catch {
		memo = {};
	}
	return memo;
}
function persist() {
	try {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(EV_CACHE, JSON.stringify(memo));
	} catch {
		/* best effort */
	}
}

/**
 * Sealed product from before this date is where the floor matters: old enough
 * that the MSRP-times-age heuristic is nonsense, and mostly not listed anywhere
 * live. Defined here because it is a property of the floor, and read by game.js.
 */
export const VINTAGE_BEFORE = Date.parse('2006-01-01');

export function isVintage(released) {
	return !!released && Date.parse(released) < VINTAGE_BEFORE;
}

function entryFor(code, packTypeId) {
	return store()[`${String(code).toLowerCase()}:${packTypeId}`] || null;
}

/**
 * Cached EV, or null when it is missing OR old enough to be worth recomputing.
 * This is the "do I need to do the work again" question, so it is the one
 * packEvUsd asks itself. It is NOT the right question for pricing — see below.
 */
export function cachedPackEv(code, packTypeId) {
	const e = entryFor(code, packTypeId);
	if (!e || Date.now() - e.at > TTL_MS) return null;
	return e.ev;
}

/**
 * The EV to use as a price floor, at ANY age.
 *
 * Expiring a floor is worse than using a slightly stale one. Card prices drift a
 * few percent over a fortnight; the alternative when the floor goes missing is
 * the heuristic, which prices an Alpha booster at $43 against singles worth
 * thousands — a 489x error. A three-week-old $4,183 is not perfect. It is not
 * wrong by two and a half orders of magnitude either.
 */
export function lastKnownPackEv(code, packTypeId) {
	return entryFor(code, packTypeId)?.ev ?? null;
}

/**
 * Expected singles value of one pack, in USD. Computed exactly from the sheets.
 * @returns {Promise<number|null>} null when there is no collation for this product
 */
export async function packEvUsd(code, packTypeId) {
	code = String(code).toLowerCase();
	const key = `${code}:${packTypeId}`;
	const hit = cachedPackEv(code, packTypeId);
	if (hit != null) return hit;

	const slice = await getCollation(code);
	if (!slice) return null;
	const variantKey = variantForProduct(slice, packTypeId);
	if (!variantKey) return null;
	const variant = slice.variants[variantKey];

	// Price every card the sheets can produce. Same source the opener uses, so
	// the EV and the cards a player actually pulls agree.
	const packSet = slice.setCode.toLowerCase();
	let index = {};
	try {
		index = await getSetPrints(packSet);
	} catch {
		index = {};
	}
	const missing = [];
	for (const uuid of Object.keys(slice.cards)) {
		const id = slice.cards[uuid]?.s;
		if (id && !index[id]) missing.push(id);
	}
	if (missing.length) {
		try {
			Object.assign(index, await resolveCardsByIds(missing));
		} catch {
			/* price what we can */
		}
	}

	const priceOf = (uuid, foil) => {
		const id = slice.cards[uuid]?.s;
		const c = id ? index[id] : null;
		if (!c) return 0;
		if (foil) return c.usdFoil ?? c.usd ?? 0;
		return c.usd ?? c.usdFoil ?? 0;
	};

	// Average over the weighted pack configurations, exactly as the sampler does.
	const total = variant.boostersTotalWeight;
	let ev = 0;
	for (const cfg of variant.boosters) {
		const pCfg = cfg.weight / total;
		for (const [sheetName, count] of Object.entries(cfg.contents)) {
			const sheet = variant.sheets[sheetName];
			if (!sheet?.totalWeight) continue;
			let sheetEv = 0;
			for (const [uuid, w] of Object.entries(sheet.cards)) {
				sheetEv += (w / sheet.totalWeight) * priceOf(uuid, sheet.foil);
			}
			ev += pCfg * count * sheetEv;
		}
	}

	store()[key] = { ev, at: Date.now() };
	persist();
	return ev;
}

/**
 * Compute the floor for vintage product up front, in the background.
 *
 * Without this, the EV is only ever computed by a visit to /store/<set>, so the
 * store index priced an Alpha booster at $43 until someone happened to open its
 * page — and then at $21,179. Azure never mounts .cache, so every new revision
 * started over from the cheap number.
 *
 * Bounded work: only sets old enough for the floor to bind, and only those whose
 * EV is missing or stale. Three at a time, because each one may fetch a collation
 * slice and a page of prices, and this is a background task with no deadline.
 */
export async function warmVintageEv(sets, { concurrency = 3 } = {}) {
	const jobs = [];
	for (const s of sets || []) {
		if (!isVintage(s?.released)) continue;
		for (const t of s.packTypes || []) {
			if (cachedPackEv(s.code, t) == null) jobs.push([s.code, t]);
		}
	}
	if (!jobs.length) return { computed: 0, failed: 0, skipped: 0 };

	let computed = 0;
	let failed = 0;
	let skipped = 0;
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const [code, type] = jobs[next++];
			try {
				const ev = await packEvUsd(code, type);
				if (ev == null) skipped++;
				else computed++;
			} catch {
				failed++;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

	console.log(
		`vintage pack EV warmed: ${computed} computed, ${skipped} without collation, ${failed} failed`
	);
	return { computed, failed, skipped };
}
