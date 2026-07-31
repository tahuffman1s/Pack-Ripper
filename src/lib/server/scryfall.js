import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scryfall data access with aggressive on-disk caching.
 *
 * Scryfall asks callers to identify themselves and throttle to ~10 req/s. We
 * fetch each set's card pool exactly once, normalise it down to the fields we
 * need, and cache it under .cache/. Prices are embedded in that snapshot.
 */

const API = 'https://api.scryfall.com';
const CACHE_DIR = join(process.cwd(), '.cache');
const POOL_DIR = join(CACHE_DIR, 'pools');
const PRINT_DIR = join(CACHE_DIR, 'prints');
const ART_DIR = join(CACHE_DIR, 'art');
const SETS_CACHE = join(CACHE_DIR, 'sets.json');
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const SHORT_TTL_MS = 1000 * 60 * 60 * 6; // a pool that still looks incomplete

const HEADERS = {
	'User-Agent': 'PackRipper/0.1 (MTG pack-opening simulator; contact: local)',
	Accept: 'application/json;q=0.9,*/*;q=0.8'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
	if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
	if (!existsSync(POOL_DIR)) mkdirSync(POOL_DIR, { recursive: true });
	if (!existsSync(PRINT_DIR)) mkdirSync(PRINT_DIR, { recursive: true });
	if (!existsSync(ART_DIR)) mkdirSync(ART_DIR, { recursive: true });
}

/**
 * Parsed disk caches, held in process.
 *
 * Every read used to re-parse the file. A set's print index is up to 1.3 MB of
 * JSON and a mass rip asks for it once per pack, so a 216-pack rip spent
 * hundreds of megabytes of JSON.parse re-deriving an object that cannot have
 * changed. Keyed by path and invalidated by the file's own mtime, so a rebuilt
 * cache file is still picked up.
 */
const parsed = new Map();

function readCache(path) {
	try {
		if (!existsSync(path)) return null;
		const stamp = statSync(path).mtimeMs;
		const hit = parsed.get(path);
		if (hit && hit.stamp === stamp) {
			return Date.now() - hit.fetchedAt > hit.ttl ? null : hit.data;
		}
		const { fetchedAt, ttl, data } = JSON.parse(readFileSync(path, 'utf-8'));
		if (!fetchedAt) return null;
		parsed.set(path, { stamp, fetchedAt, ttl: ttl || CACHE_TTL_MS, data });
		return Date.now() - fetchedAt > (ttl || CACHE_TTL_MS) ? null : data;
	} catch {
		return null;
	}
}

function writeCache(path, data, ttl) {
	ensureDirs();
	writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), ttl: ttl || undefined, data }));
	try {
		parsed.set(path, { stamp: statSync(path).mtimeMs, fetchedAt: Date.now(), ttl: ttl || CACHE_TTL_MS, data });
	} catch {
		parsed.delete(path);
	}
}

async function apiGet(path) {
	const res = await fetch(API + path, { headers: HEADERS });
	if (res.status === 429) {
		// A 429 is client-wide and lasts ~60s; retrying sooner just extends it.
		await sleep(60000);
		return apiGet(path);
	}
	if (!res.ok) {
		throw new Error(`Scryfall ${res.status} for ${path}`);
	}
	return res.json();
}

/** Extract the best-effort image set for a card (handles double-faced cards). */
function imagesFor(card) {
	const pick = (uris) =>
		uris
			? {
					small: uris.small,
					normal: uris.normal,
					large: uris.large,
					art: uris.art_crop
				}
			: null;
	if (card.image_uris) return pick(card.image_uris);
	if (card.card_faces?.length) {
		const face = card.card_faces.find((f) => f.image_uris) || card.card_faces[0];
		return pick(face.image_uris);
	}
	return null;
}

function normalizeCard(card) {
	const usd = card.prices?.usd ? parseFloat(card.prices.usd) : null;
	const usdFoil = card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null;
	const usdEtched = card.prices?.usd_etched ? parseFloat(card.prices.usd_etched) : null;
	// Cardmarket prices, in euros. Scryfall's USD comes from TCGplayer, which has
	// no listing at all for many vintage cards — 62 of 175 Alpha cards have no
	// usd, and 61 of those DO have a eur. Without this, Ancestral Recall is $0.
	const eur = card.prices?.eur ? parseFloat(card.prices.eur) : null;
	const eurFoil = card.prices?.eur_foil ? parseFloat(card.prices.eur_foil) : null;
	return {
		id: card.id,
		oracleId: card.oracle_id,
		name: card.name,
		set: card.set,
		setName: card.set_name,
		number: card.collector_number,
		rarity: card.rarity,
		colors: card.color_identity || [],
		manaCost: card.mana_cost || (card.card_faces?.[0]?.mana_cost ?? ''),
		typeLine: card.type_line || '',
		images: imagesFor(card),
		usd,
		usdFoil,
		usdEtched,
		eur,
		eurFoil,
		// whether a foil price exists / foil is available
		foilAvailable: !!card.foil,
		// treatment fields — these are what make a borderless/showcase/etched
		// pull visibly different from the plain printing of the same card.
		finishes: card.finishes || [],
		frame: card.frame || '',
		frameEffects: card.frame_effects || [],
		promoTypes: card.promo_types || [],
		borderColor: card.border_color || 'black',
		fullArt: !!card.full_art,
		textless: !!card.textless,
		securityStamp: card.security_stamp || null,
		// NOTE: `booster` means "in the set's main numbered run", NOT "obtainable
		// from a pack". Every MKM showcase/borderless/extended-art card is
		// booster:false and every one of them comes out of real Play Boosters.
		booster: !!card.booster,
		scryfallUri: card.scryfall_uri
	};
}

/** Paginate a Scryfall search fully, returning normalized cards. */
async function searchAll(query, { unique = 'cards', extras = false } = {}) {
	const cards = [];
	let path =
		`/cards/search?q=${encodeURIComponent(query)}&unique=${unique}&order=set` +
		(extras ? '&include_extras=true&include_variations=true' : '');
	let guard = 0;
	while (path && guard < 60) {
		guard++;
		let page;
		try {
			page = await apiGet(path);
		} catch (e) {
			// A search with zero results returns 404; treat as empty.
			break;
		}
		for (const c of page.data || []) cards.push(normalizeCard(c));
		if (page.has_more && page.next_page) {
			path = page.next_page.replace(API, '');
			// Scryfall asks for ~10 req/s but penalises bursts with a 60s
			// client-wide 429, so crawls stay well under that.
			await sleep(750);
		} else {
			path = null;
		}
	}
	return cards;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve specific cards by Scryfall id via POST /cards/collection.
 * Max 75 identifiers per request, and one malformed id fails the whole batch
 * with a 400, so ids are shape-checked first.
 *
 * `answered` is the subset of ids Scryfall actually gave a verdict on — a batch
 * lost to a network error or a 5xx is absent from it. That is the difference
 * between "this printing does not exist" and "we could not ask", which matters
 * to the caller: only the former is worth remembering.
 *
 * @returns {Promise<{cards:Record<string,object>, answered:Set<string>}>}
 */
export async function getCardsByIds(ids) {
	const cards = {};
	const answered = new Set();
	const valid = [...new Set(ids)].filter((id) => UUID_RE.test(id));
	for (let i = 0; i < valid.length; i += 75) {
		const batch = valid.slice(i, i + 75);
		try {
			const res = await fetch(`${API}/cards/collection`, {
				method: 'POST',
				headers: { ...HEADERS, 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifiers: batch.map((id) => ({ id })) })
			});
			if (!res.ok) continue;
			const body = await res.json();
			for (const c of body.data || []) cards[c.id] = normalizeCard(c);
			for (const id of batch) answered.add(id);
		} catch {
			/* skip this batch; caller falls back */
		}
		if (i + 75 < valid.length) await sleep(750);
	}
	return { cards, answered };
}

/**
 * Persistent by-id cache for one-off lookups — cards a pack pulls from a
 * companion set (The List, Special Guests) where crawling the whole set would
 * be wasteful for the one or two cards a pack actually needs.
 */
const BYID_CACHE = () => join(PRINT_DIR, '_byid.json');
let byIdMemo = null;

function loadById() {
	if (byIdMemo) return byIdMemo;
	try {
		byIdMemo = existsSync(BYID_CACHE()) ? JSON.parse(readFileSync(BYID_CACHE(), 'utf-8')) : {};
	} catch {
		byIdMemo = {};
	}
	return byIdMemo;
}

/**
 * Ids Scryfall has confirmed it does not have. Without this, an id MTGJSON knows
 * and Scryfall does not is re-requested on every single lookup, forever — which
 * for a mass rip means one pointless round trip per pack.
 *
 * Only confirmed absences go in here, never a failed request: tombstoning an id
 * because Scryfall was briefly down would strip that card's art for the rest of
 * the process. In-process only, so a restart is a fair moment to ask again in
 * case the printing has since landed.
 */
const byIdMisses = new Set();

export async function resolveCardsByIds(ids) {
	const store = loadById();
	const out = {};
	const missing = [];
	for (const id of new Set(ids)) {
		if (store[id]) out[id] = store[id];
		else if (!byIdMisses.has(id)) missing.push(id);
	}
	if (missing.length) {
		const { cards, answered } = await getCardsByIds(missing);
		let changed = false;
		for (const id of missing) {
			const card = cards[id];
			if (card) {
				out[id] = card;
				store[id] = card;
				changed = true;
			} else if (answered.has(id)) {
				byIdMisses.add(id);
			}
		}
		// The store is several megabytes, so it is serialised once per call and
		// only when the call actually learnt something. Callers that need many
		// ids should ask for them in one call rather than one at a time.
		if (changed) {
			try {
				ensureDirs();
				writeFileSync(BYID_CACHE(), JSON.stringify(store));
			} catch {
				/* cache is best-effort */
			}
		}
	}
	return out;
}

/**
 * Every PRINTING in a set, indexed by Scryfall id — including the showcase,
 * borderless and extended-art cards that the old `is:booster -is:extra` query
 * structurally could not return. This is the index MTGJSON collation joins to.
 */
export async function getSetPrints(code) {
	code = String(code).toLowerCase();
	const cachePath = join(PRINT_DIR, `${code}.json`);
	const cached = readCache(cachePath);
	if (cached) return cached;

	const meta = await getSetMeta(code);
	const cards = await searchAll(`set:${code}`, { unique: 'prints', extras: true });
	stampRetro(cards, meta?.released);
	fillMissingPrices(cards);
	const index = {};
	for (const c of cards) index[c.id] = c;
	if (Object.keys(index).length) writeCache(cachePath, index);
	return index;
}

/**
 * The 1997 card frame is only a "retro frame" *treatment* when it appears in a
 * modern set. In 1998 it was simply the card frame, so tagging every Urza's
 * Saga common as RETRO FRAME would be wrong. The modern frame arrived with
 * Eighth Edition (2003-07-28).
 */
const MODERN_FRAME_ERA = Date.parse('2003-07-28');

/**
 * Fill in missing USD prices from the euro price.
 *
 * The rate is DERIVED from the cards themselves — the median usd/eur ratio over
 * every card in the batch that has both — so it tracks the real market without
 * a hardcoded currency constant or an extra API call. Cards priced this way are
 * flagged `usdFromEur` so the source stays visible.
 */
function fillMissingPrices(cards) {
	const ratios = [];
	for (const c of cards) {
		if (c.usd > 0 && c.eur > 0) ratios.push(c.usd / c.eur);
	}
	let rate = null;
	if (ratios.length >= 8) {
		ratios.sort((a, b) => a - b);
		rate = ratios[ratios.length >> 1];
	}
	if (!(rate > 0)) return cards; // no basis to convert; leave prices as they are

	for (const c of cards) {
		if (!(c.usd > 0) && c.eur > 0) {
			c.usd = Number((c.eur * rate).toFixed(2));
			c.usdFromEur = true;
		}
		if (!(c.usdFoil > 0) && c.eurFoil > 0) {
			c.usdFoil = Number((c.eurFoil * rate).toFixed(2));
		}
	}

	// A handful of cards have no listing in either currency — mostly the ones
	// Wizards withdrew from print, which simply are not traded. Showing an Alpha
	// rare as $0 is worse than estimating it, so they take the median price of
	// their own rarity in the same set: derived from neighbours, not invented.
	const byRarity = {};
	for (const c of cards) {
		if (c.usd > 0) (byRarity[c.rarity] ??= []).push(c.usd);
	}
	for (const list of Object.values(byRarity)) list.sort((a, b) => a - b);
	for (const c of cards) {
		if (c.usd > 0) continue;
		const list = byRarity[c.rarity];
		if (!list?.length) continue;
		c.usd = list[list.length >> 1];
		c.usdEstimated = true;
	}
	return cards;
}

function stampRetro(cards, released) {
	const relMs = released ? Date.parse(released) : Date.now();
	const modernSet = relMs >= MODERN_FRAME_ERA;
	for (const c of cards) c.retro = modernSet && c.frame === '1997';
	return cards;
}

/** List of all Scryfall sets (lightly trimmed), cached. */
export async function getAllSets() {
	const cached = readCache(SETS_CACHE);
	if (cached) return cached;
	const data = await apiGet('/sets');
	const sets = (data.data || []).map((s) => ({
		code: s.code,
		name: s.name,
		type: s.set_type,
		released: s.released_at,
		cardCount: s.card_count,
		icon: s.icon_svg_uri,
		digital: s.digital
	}));
	writeCache(SETS_CACHE, sets);
	return sets;
}

export async function getSetMeta(code) {
	const sets = await getAllSets();
	return sets.find((s) => s.code === code) || null;
}

/**
 * Build (or load) a rarity-separated card pool for a set, suitable for pack
 * generation. Returns { code, name, cards: {common,uncommon,rare,mythic,land}, prices }.
 */
/**
 * Printings that exist only as promos — prerelease stamps, buy-a-box, judge
 * and player rewards. These are in the set but were never in a pack, so the
 * synthesized-pool fallback must not offer them.
 */
const PROMO_ONLY = new Set([
	'prerelease', 'datestamped', 'buyabox', 'promopack', 'judgegift',
	'playerrewards', 'release', 'setpromo', 'gameday', 'intropack',
	'draftweekend', 'openhouse', 'themepack', 'giftbox', 'convention',
	'bundle', 'storechampionship', 'planeswalkerdeck', 'brawldeck'
]);

function isPromoOnly(card) {
	const types = card.promoTypes || [];
	// promoTypes is the whole story. Security stamps are NOT a promo signal: the
	// oval holostamp is the ordinary mark on every rare and mythic in a modern
	// booster (MKM 145/145, NEO 172/175), and triangle is its Universes Beyond
	// equivalent. Reading the stamp deleted every rare and mythic from the
	// synthesized pool, which silently stripped the rare slot out of any pack
	// that fell back to it.
	return types.some((t) => PROMO_ONLY.has(t));
}

/** Sort a flat card list into rarity buckets (+ a basic-land bucket). */
function distribute(cards, meta, code) {
	const pool = {
		code,
		name: meta?.name || code.toUpperCase(),
		icon: meta?.icon || null,
		released: meta?.released || null,
		cards: { common: [], uncommon: [], rare: [], mythic: [], land: [] }
	};
	for (const c of cards) {
		if (/Basic Land/i.test(c.typeLine)) {
			pool.cards.land.push(c);
			continue;
		}
		if (pool.cards[c.rarity]) pool.cards[c.rarity].push(c);
	}
	return pool;
}

/** Set codes whose card pool is already cached on disk (no network needed). */
export function cachedPoolCodes() {
	try {
		return readdirSync(POOL_DIR)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.slice(0, -5));
	} catch {
		return [];
	}
}

export async function getSetPool(code) {
	code = String(code).toLowerCase();
	const cachePath = join(POOL_DIR, `${code}.json`);
	const cached = readCache(cachePath);
	// Re-fetch a cached pool that fails the sanity check rather than serve it:
	// otherwise one bad fetch keeps a set's packs rare-less for a fortnight.
	if (cached && poolIsUsable(cached)) return cached;

	const meta = await getSetMeta(code);

	// Every printing in the set, treatments included. The old query here was
	// `set:X is:booster -is:extra`, which structurally cannot return a showcase,
	// borderless or extended-art card: `booster` means "in the main numbered
	// run", and for MKM that excludes 90 of the 376 cards its Play Boosters
	// actually contain. Promo-only printings are filtered instead.
	let cards = (await searchAll(`set:${code} -t:token -t:emblem`, { unique: 'prints', extras: true })).filter(
		(c) => !isPromoOnly(c)
	);
	stampRetro(cards, meta?.released);
	fillMissingPrices(cards);
	let pool = distribute(cards, meta, code);

	// If filtering promos emptied the pool (some sets are almost entirely
	// promotional), keep everything rather than show an empty pack.
	if (!poolIsUsable(pool) && cards.length === 0) {
		cards = await searchAll(`set:${code} -t:token -t:emblem`, { unique: 'prints', extras: true });
		if (cards.length) pool = distribute(cards, meta, code);
	}
	if (!poolIsUsable(pool)) {
		cards = await searchAll(`set:${code}`);
		if (cards.length) pool = distribute(cards, meta, code);
	}

	// Land slot fallback: use the set's basics, else a few commons.
	if (pool.cards.land.length === 0) {
		const basics = await searchAll(`set:${code} type:basic`);
		if (basics.length) pool.cards.land = basics;
	}
	if (pool.cards.land.length === 0) {
		pool.cards.land = pool.cards.common.slice(0, 10);
	}

	// A set still mid-spoiler genuinely has no rares yet. Cache it briefly so it
	// heals on its own instead of being re-fetched on every request.
	writeCache(cachePath, pool, poolIsUsable(pool) ? undefined : SHORT_TTL_MS);
	return pool;
}

function bestArtFrom(cards) {
	// prefer the priciest mythic/rare that has real art
	const ranked = cards
		.filter((c) => c?.images?.art)
		.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
	return ranked[0] || null;
}

/**
 * A set's "pack art": a marquee card's full art plus the set symbol, used to
 * skin the 3D booster so it resembles the real product. Cached to disk.
 * @returns {Promise<{name:string,icon:string|null,art:string|null,artName:string|null,released:string|null,cardCount:number|null}>}
 */
export async function getSetArt(code) {
	code = String(code).toLowerCase();
	const cachePath = join(ART_DIR, `${code}.json`);
	const cached = readCache(cachePath);
	if (cached) return cached;

	const meta = await getSetMeta(code);
	let key = null;

	// Reuse the already-fetched pool if we have it — no extra network call.
	const pool = readCache(join(POOL_DIR, `${code}.json`));
	if (pool?.cards) {
		key = bestArtFrom([...(pool.cards.mythic || []), ...(pool.cards.rare || [])]) || bestArtFrom(pool.cards.uncommon || []);
	}

	// Otherwise fetch a single marquee card (dropping is:booster if needed).
	if (!key) {
		let cards = await searchAll(`set:${code} is:booster (rarity:mythic OR rarity:rare)`);
		if (!cards.length) cards = await searchAll(`set:${code} (rarity:mythic OR rarity:rare) -is:extra`);
		if (!cards.length) cards = await searchAll(`set:${code} -is:extra`);
		key = bestArtFrom(cards);
	}

	const artUrl = key?.images?.art || key?.images?.normal || null;

	// Embed the art as a same-origin data URL so the client can draw it onto a
	// canvas / WebGL texture without any CORS taint (the fragile part of loading
	// cross-origin images into a canvas). Falls back to the plain URL on failure.
	let artData = null;
	if (artUrl) {
		try {
			const r = await fetch(artUrl, { headers: HEADERS });
			if (r.ok) {
				const buf = Buffer.from(await r.arrayBuffer());
				const mime = r.headers.get('content-type') || 'image/jpeg';
				artData = `data:${mime};base64,${buf.toString('base64')}`;
			}
		} catch {
			/* keep artData null; client can still use artUrl */
		}
	}

	const result = {
		name: meta?.name || code.toUpperCase(),
		icon: meta?.icon || null,
		released: meta?.released || null,
		cardCount: meta?.cardCount || null,
		art: artUrl,
		artData,
		artName: key?.name || null
	};
	writeCache(cachePath, result);
	return result;
}

/** Return true if we have enough real cards to build a pack (the opener's slot
 *  fallback fills any missing rarity from whatever rarities exist). */
export function poolIsUsable(pool) {
	if (!pool) return false;
	const { common, uncommon, rare, mythic } = pool.cards;
	const n = common.length + uncommon.length + rare.length + mythic.length;
	if (n < 8) return false;
	// Every booster set has rares. A pool with a full common/uncommon run but
	// next to no rares is a truncated fetch or an over-eager filter, not a real
	// set — and cached as-is it strips the rare slot out of every pack from that
	// set, quietly, for the whole TTL.
	if (n >= 40 && rare.length + mythic.length < Math.max(4, n * 0.06)) return false;
	return true;
}

// ── Card faces ─────────────────────────────────────────────────

/**
 * Both faces of one printing, for the 3D card viewer's flip.
 *
 * A stored card instance carries ONE image — the front — because that is all any
 * screen needed until now. A transforming card, a modal double-faced card and a
 * reversible printing all have a real second face, and the back of the card the
 * player is holding is that face rather than a Magic card back.
 *
 * Deliberately its own tiny cache rather than a field added to the print records:
 * the by-id store and the per-set print indexes already on disk were written
 * without a faces field, so adding one would leave every card pulled before today
 * without a back until its cache expired (and the by-id store has no expiry at
 * all). One endpoint, one file, correct for every card ever pulled.
 *
 * A printing's faces never change, so entries never expire.
 */
const FACES_CACHE = () => join(PRINT_DIR, '_faces.json');
let facesMemo = null;

function loadFaces() {
	if (facesMemo) return facesMemo;
	try {
		facesMemo = existsSync(FACES_CACHE()) ? JSON.parse(readFileSync(FACES_CACHE(), 'utf-8')) : {};
	} catch {
		facesMemo = {};
	}
	return facesMemo;
}

/** Ids Scryfall has confirmed it does not have. In-process; see byIdMisses. */
const facesMisses = new Set();

/**
 * @returns {Promise<{layout:string, faces:{name:string,image:string|null}[]}|null>}
 *   null when the id is unknown or unreachable. A single-faced card returns one
 *   entry, which is the answer "there is no second face" rather than an error.
 */
export async function getCardFaces(id) {
	if (!UUID_RE.test(String(id))) return null;
	const store = loadFaces();
	if (store[id]) return store[id];
	if (facesMisses.has(id)) return null;

	let card;
	try {
		card = await apiGet(`/cards/${id}`);
	} catch (e) {
		// A 404 is an answer worth remembering; anything else might be transient, and
		// tombstoning on a blip would strip the back off a card for the whole process.
		if (String(e.message).includes('404')) facesMisses.add(id);
		return null;
	}

	const pick = (uris) => uris?.png || uris?.large || uris?.normal || null;
	const faces = card.card_faces?.length
		? card.card_faces.map((f) => ({
				name: f.name || card.name,
				image: pick(f.image_uris) || pick(card.image_uris)
			}))
		: [{ name: card.name, image: pick(card.image_uris) }];

	const record = { layout: card.layout || 'normal', faces };
	store[id] = record;
	try {
		ensureDirs();
		writeFileSync(FACES_CACHE(), JSON.stringify(store));
	} catch {
		/* cache is best-effort */
	}
	return record;
}
