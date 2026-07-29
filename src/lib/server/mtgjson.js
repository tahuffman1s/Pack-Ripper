/**
 * MTGJSON v5 transport.
 *
 * MTGJSON publishes real booster collation per set — the weighted print sheets
 * Wizards actually used — under `data.booster`. That is the only public source
 * of it: no hosted API generates a correctly-collated pack (every candidate was
 * probed; see README). Scryfall stays the source of images and prices.
 *
 * Licence: MTGJSON is MIT, (c) Zach Halpern.
 *
 * Zero native dependencies — gunzip comes from node:zlib.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const API = 'https://mtgjson.com/api/v5';
const CACHE_DIR = join(process.cwd(), '.cache', 'collation');
const META_CACHE = join(CACHE_DIR, '_meta.json');
const META_TTL_MS = 1000 * 60 * 60 * 24; // re-check the build version daily

const HEADERS = {
	'User-Agent': 'PackRipper/0.2 (MTG pack-opening simulator; contact: local)',
	'Accept-Encoding': 'gzip'
};

/** Windows-reserved device names; MTGJSON suffixes these with an underscore. */
const RESERVED = new Set([
	'CON', 'PRN', 'AUX', 'NUL',
	'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
	'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

export function mtgjsonFileName(code) {
	const up = String(code).toUpperCase();
	return RESERVED.has(up) ? `${up}_` : up;
}

function ensureDir() {
	if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/** Single-flight map so two concurrent cold opens don't both download. */
const inflight = new Map();
function once(key, fn) {
	if (inflight.has(key)) return inflight.get(key);
	const p = Promise.resolve()
		.then(fn)
		.finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/**
 * The current MTGJSON build version, used to invalidate cached slices.
 * Meta.json is 113 bytes, so polling it daily is free.
 */
export async function mtgjsonMeta() {
	try {
		if (existsSync(META_CACHE)) {
			const c = JSON.parse(readFileSync(META_CACHE, 'utf-8'));
			if (Date.now() - c.fetchedAt < META_TTL_MS) return c.data;
		}
	} catch {
		/* fall through and refetch */
	}
	return once('meta', async () => {
		try {
			const res = await fetch(`${API}/Meta.json`, { headers: HEADERS });
			if (!res.ok) return null;
			const body = await res.json();
			const data = body?.data || body?.meta || null;
			if (data) {
				ensureDir();
				writeFileSync(META_CACHE, JSON.stringify({ fetchedAt: Date.now(), data }));
			}
			return data;
		} catch {
			return null;
		}
	});
}

/**
 * Fetch and parse one set file. Returns the `data` object, or null if MTGJSON
 * has no file for this set (brand-new or non-product sets 404).
 *
 * Sizes are modest — MKM.json.gz is 1.2 MB, LEA.json.gz 150 KB — and we only
 * ever keep the derived slice, never the raw file.
 */
export async function fetchSetFile(code) {
	const name = mtgjsonFileName(code);
	return once(`set:${name}`, async () => {
		const url = `${API}/${name}.json.gz`;
		let res;
		try {
			res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
		} catch {
			return null;
		}
		if (!res.ok) return null;

		let text;
		try {
			const buf = Buffer.from(await res.arrayBuffer());
			// Some CDN paths transparently decompress; detect the gzip magic.
			const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
			text = (isGzip ? gunzipSync(buf) : buf).toString('utf-8');
		} catch {
			// Truncated or corrupt body — treat as unavailable rather than throw.
			return null;
		}

		try {
			return JSON.parse(text)?.data ?? null;
		} catch {
			return null;
		}
	});
}
