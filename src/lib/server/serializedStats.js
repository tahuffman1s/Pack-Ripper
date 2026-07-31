/**
 * Derives serialized-card statistics from the sets MTGJSON actually models,
 * so the sets it does NOT model get numbers grounded in real data instead of
 * invented constants.
 *
 * Wizards publishes only "less than 1%" and no API exposes a print run, so the
 * two missing numbers — pull rate and run length — are taken as the median of
 * what the modelled sets demonstrably do. Recomputed from live collation and
 * cached to disk; nothing here is a typed-in probability.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCollation, serializedRateOf } from './collation.js';

const CACHE_DIR = join(process.cwd(), '.cache', 'collation');
const STATS_CACHE = join(CACHE_DIR, '_serialized-stats.json');
const TTL_MS = 1000 * 60 * 60 * 24 * 90;

/** Reference sets: every set known to carry serialized cards on real sheets. */
const REFERENCE_SETS = ['bro', 'rvr', 'mom', 'ltr'];

function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

let memo = null;

/**
 * @returns {Promise<{rate:number, run:number, samples:{code:string,rate:number}[]}>}
 */
export async function observedSerializedStats() {
	if (memo) return memo;
	try {
		if (existsSync(STATS_CACHE)) {
			const c = JSON.parse(readFileSync(STATS_CACHE, 'utf-8'));
			if (Date.now() - c.at < TTL_MS && c.data?.rate) {
				memo = c.data;
				return memo;
			}
		}
	} catch {
		/* recompute */
	}

	const samples = [];
	const runs = [];
	for (const code of REFERENCE_SETS) {
		let slice;
		try {
			slice = await getCollation(code);
		} catch {
			continue;
		}
		if (!slice) continue;
		for (const variantKey of Object.keys(slice.variants)) {
			// Only ordinary Collector Boosters. LTR's `collector-special` is the
			// holiday Special Edition box at 8.7%, which is not representative
			// of anything a player buys off a shelf.
			if (variantKey !== 'collector') continue;
			const rate = serializedRateOf(slice, variantKey);
			if (rate > 0) samples.push({ code, variant: variantKey, rate });
		}
		// LTR encodes print runs as sheet weight x100; harvest them as run samples.
		if (code === 'ltr') {
			for (const v of Object.values(slice.variants)) {
				for (const sheet of Object.values(v.sheets)) {
					for (const [uuid, w] of Object.entries(sheet.cards)) {
						if ((slice.cards[uuid]?.p || []).includes('serialized') && w > 1) runs.push(w * 100);
					}
				}
			}
		}
	}

	const data = {
		// Median observed per-pack rate across modelled sets.
		rate: median(samples.map((s) => s.rate)) ?? 0.005,
		// Median observed print run; LTR's 300/700/900 are the only runs any
		// API exposes, so their median is the best grounded default.
		run: Math.round(median(runs) ?? 500),
		samples
	};

	try {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(STATS_CACHE, JSON.stringify({ at: Date.now(), data }));
	} catch {
		/* best effort */
	}
	memo = data;
	return data;
}

// "Whether this set's serialized cards already arrive through collation" used to
// be answered here, by a hardcoded set of seven codes. It is answered by
// sheetsCarrySerialized() in opener.js now, which asks the set's own sheets —
// the list was missing eleven of the fourteen sets that sheet them. Nothing else
// consulted it, so it is gone rather than left around to be trusted again.
