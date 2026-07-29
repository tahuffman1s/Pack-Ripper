import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real sealed-product prices from TCGplayer, sourced via tcgcsv.com — a free,
 * no-auth daily mirror of TCGplayer's category/group/product/price data.
 *
 * We map each Magic set to a TCGplayer "group", pull its products, and pick out
 * the sealed booster PACK and BOX for each product line (Draft / Set / Play /
 * Jumpstart / Collector), keyed to a real market price. These prices drive the
 * store (e.g. a Tempest booster pack really costs ~$100), with the heuristic in
 * pricing.js as a fallback when TCGplayer has no match.
 */

const BASE = 'https://tcgcsv.com/tcgplayer';
const MAGIC = 1; // TCGplayer category id for Magic
const CACHE_DIR = join(process.cwd(), '.cache', 'tcg');
const IMG_DIR = join(CACHE_DIR, 'img');
const GROUPS_CACHE = join(CACHE_DIR, 'groups.json');
const SEALED_CACHE = join(CACHE_DIR, 'sealed.json');
const GROUPS_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
const SEALED_TTL = 1000 * 60 * 60 * 24 * 3; // 3 days
const IMG_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

/** Upscale a TCGplayer product thumbnail URL to the 1000×1000 variant. */
function bigImage(url) {
	return url ? url.replace(/_[^_/]+\.jpg$/i, '_in_1000x1000.jpg') : url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir() {
	if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		return null;
	}
}
function writeJson(path, obj) {
	ensureDir();
	const tmp = path + '.tmp';
	writeFileSync(tmp, JSON.stringify(obj));
	renameSync(tmp, path);
}

async function apiGet(path) {
	const res = await fetch(BASE + path, {
		headers: {
			Accept: 'application/json',
			// tcgcsv requires a descriptive User-Agent or it returns 401.
			'User-Agent': 'PackRipper/0.1 (MTG pack-opening simulator; self-hosted)'
		}
	});
	if (!res.ok) throw new Error(`tcgcsv ${res.status} ${path}`);
	const body = await res.json();
	return body.results || body;
}

// ── Group (set) resolution ─────────────────────────────────────
let groupsByAbbr = null;
let groupsByName = null;

function normalizeName(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/universes beyond:?/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

async function ensureGroups() {
	if (groupsByAbbr) return;
	let cached = readJson(GROUPS_CACHE);
	if (!cached || Date.now() - cached.fetchedAt > GROUPS_TTL) {
		const groups = await apiGet(`/${MAGIC}/groups`);
		cached = { fetchedAt: Date.now(), groups };
		writeJson(GROUPS_CACHE, cached);
	}
	groupsByAbbr = new Map();
	groupsByName = new Map();
	for (const g of cached.groups) {
		if (g.abbreviation) groupsByAbbr.set(String(g.abbreviation).toLowerCase(), g);
		groupsByName.set(normalizeName(g.name), g);
	}
}

function resolveGroup(setCode, setName) {
	const byAbbr = groupsByAbbr.get(String(setCode).toLowerCase());
	if (byAbbr) return byAbbr;
	const norm = normalizeName(setName);
	if (groupsByName.has(norm)) return groupsByName.get(norm);
	// loose containment match
	for (const [name, g] of groupsByName) {
		if (name && (name.includes(norm) || norm.includes(name)) && Math.abs(name.length - norm.length) < 8) {
			return g;
		}
	}
	return null;
}

// ── Product classification ─────────────────────────────────────
const EXCLUDE = /tournament|theme deck|fat pack|bundle|blister|prerelease|starter|planeswalker deck|commander deck|deck |gift|case|kit|collection|sample|omega|promo pack|land station|mongrel|welcome/i;

/** Classify a sealed product name into {type, kind} or null. */
function classify(name) {
	const n = name.toLowerCase();
	if (EXCLUDE.test(n)) return null;
	if (!/booster/.test(n)) return null;

	const isBox = /box|display/.test(n);
	const isPack = /pack/.test(n);
	if (!isBox && !isPack) return null;

	let type;
	if (/collector booster/.test(n)) type = 'collector';
	else if (/set booster/.test(n)) type = 'set';
	else if (/play booster/.test(n)) type = 'play';
	else if (/jumpstart/.test(n)) type = 'jumpstart';
	else if (/draft booster/.test(n)) type = 'draft';
	else type = 'draft'; // plain "Booster Pack/Box" — the classic draft-era product

	return { type, kind: isBox ? 'box' : 'pack' };
}

function priceOf(p) {
	if (!p) return null;
	return p.marketPrice ?? p.midPrice ?? p.directLowPrice ?? p.lowPrice ?? null;
}

// ── In-memory sealed-price index ───────────────────────────────
let sealedIndex = null; // { [setCode]: { at, groupId, groupName, types: { draft:{pack,box}, ... } } }
let persistTimer = null;

export function initSealed() {
	if (sealedIndex) return;
	sealedIndex = readJson(SEALED_CACHE) || {};
}

function persistSoon() {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		try {
			writeJson(SEALED_CACHE, sealedIndex);
		} catch (e) {
			console.error('sealed cache write failed:', e);
		}
	}, 500);
}

/** Sync lookup of a set's sealed prices (null if unknown/stale-missing). */
export function getSealed(setCode) {
	if (!sealedIndex) return null;
	const e = sealedIndex[String(setCode).toLowerCase()];
	return e ? e.types : null;
}

function isFresh(entry) {
	return entry && Date.now() - (entry.at || 0) < SEALED_TTL;
}

/** Fetch + cache one set's sealed prices from TCGplayer. */
export async function fetchSetSealed(setCode, setName) {
	initSealed();
	setCode = String(setCode).toLowerCase();
	if (isFresh(sealedIndex[setCode])) return sealedIndex[setCode].types;

	await ensureGroups();
	const group = resolveGroup(setCode, setName);
	if (!group) {
		sealedIndex[setCode] = { at: Date.now(), groupId: null, types: {} };
		persistSoon();
		return {};
	}

	let products, prices;
	try {
		[products, prices] = await Promise.all([
			apiGet(`/${MAGIC}/${group.groupId}/products`),
			apiGet(`/${MAGIC}/${group.groupId}/prices`)
		]);
	} catch (e) {
		return sealedIndex[setCode]?.types || null;
	}

	const priceById = new Map();
	for (const p of prices) {
		// keep the highest available price per product (normal vs foil variants)
		const v = priceOf(p);
		if (v == null) continue;
		const prev = priceById.get(p.productId);
		if (prev == null || v > prev) priceById.set(p.productId, v);
	}

	const acc = {}; // type -> { pack, box, packImage, boxImage, packNameLen, boxNameLen }
	for (const prod of products) {
		const cls = classify(prod.name || '');
		if (!cls) continue;
		const t = (acc[cls.type] ??= {});
		const price = priceById.get(prod.productId);
		if (price != null) {
			// prefer the lowest sane pack price / the largest box price
			if (t[cls.kind] == null) t[cls.kind] = price;
			else t[cls.kind] = cls.kind === 'pack' ? Math.min(t[cls.kind], price) : Math.max(t[cls.kind], price);
		}
		// take the product image from the most "canonical" (shortest-named) match
		if (prod.imageUrl) {
			const lenKey = cls.kind + 'NameLen';
			const imgKey = cls.kind + 'Image';
			const len = (prod.name || '').length;
			if (t[lenKey] == null || len < t[lenKey]) {
				t[imgKey] = bigImage(prod.imageUrl);
				t[lenKey] = len;
			}
		}
	}

	const types = {};
	for (const [k, v] of Object.entries(acc)) {
		types[k] = {
			pack: v.pack ?? null,
			box: v.box ?? null,
			packImage: v.packImage || null,
			boxImage: v.boxImage || null
		};
	}

	sealedIndex[setCode] = { at: Date.now(), groupId: group.groupId, groupName: group.name, types };
	persistSoon();
	return types;
}

/** The TCGplayer product-photo URL for a set's booster pack of a given type. */
export function getPackImage(setCode, packTypeId) {
	return getSealed(setCode)?.[packTypeId]?.packImage || null;
}

/**
 * The real pack wrapper photo as a same-origin data URL (so the 3D pack can
 * texture it without CORS taint). Ensures sealed data is loaded first. Cached.
 */
export async function getPackImageData(setCode, packTypeId, setName) {
	setCode = String(setCode).toLowerCase();
	await fetchSetSealed(setCode, setName);
	const url = getPackImage(setCode, packTypeId);
	if (!url) return null;

	if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true });
	const cacheFile = join(IMG_DIR, `${setCode}-${packTypeId}.json`);
	const cached = readJson(cacheFile);
	if (cached && Date.now() - cached.at < IMG_TTL) return cached.data;

	try {
		const r = await fetch(url, {
			headers: { 'User-Agent': 'PackRipper/0.1 (MTG pack-opening simulator; self-hosted)' }
		});
		if (!r.ok) return null;
		const buf = Buffer.from(await r.arrayBuffer());
		const mime = r.headers.get('content-type') || 'image/jpeg';
		const data = `data:${mime};base64,${buf.toString('base64')}`;
		writeJson(cacheFile, { at: Date.now(), data });
		return data;
	} catch {
		return null;
	}
}

/** Background-warm sealed prices for many sets, throttled. */
export async function warmSealed(sets, { concurrency = 6, delay = 60 } = {}) {
	initSealed();
	const pending = sets.filter((s) => !isFresh(sealedIndex[String(s.code).toLowerCase()]));
	let i = 0;
	async function worker() {
		while (i < pending.length) {
			const s = pending[i++];
			try {
				await fetchSetSealed(s.code, s.name);
			} catch {
				/* skip */
			}
			await sleep(delay);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
	try {
		writeJson(SEALED_CACHE, sealedIndex);
	} catch {
		/* ignore */
	}
}
