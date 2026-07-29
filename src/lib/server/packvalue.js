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

/** Cached EV, or null if it has not been computed yet. */
export function cachedPackEv(code, packTypeId) {
	const e = store()[`${code}:${packTypeId}`];
	if (!e || Date.now() - e.at > TTL_MS) return null;
	return e.ev;
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
