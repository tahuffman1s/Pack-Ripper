import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Tiny file-backed JSON "database".
 *
 * Chosen over better-sqlite3 so the app has ZERO native build dependencies and
 * runs anywhere Node runs. Everything is kept in memory and flushed to disk
 * atomically (write temp + rename) on every mutation. Fine for a single-process
 * simulator; not meant for high concurrency.
 */

const DATA_DIR = join(process.cwd(), '.data');
const DB_PATH = join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
	users: {}, // id -> { id, username, email, passwordHash, salt, createdAt }
	usernames: {}, // lowercased username -> userId
	sessions: {}, // token -> { userId, createdAt }
	wallets: {}, // userId -> { gold }
	inventory: {}, // userId -> [ { id, setCode, packTypeId, acquiredAt } ]  (unopened packs)
	collections: {}, // userId -> [ cardInstance ]
	stats: {}, // userId -> stats object
	openings: {}, // userId -> [ recent opening summaries ]
	serials: {}, // scryfallId -> [ issued serial numbers ]  (a 1/1 exists once, globally)
	freeSpins: {}, // userId -> { remaining, lineBet, lines }  (slot bonus round)
	blackjack: {} // userId -> { shoe, phase, dealer, hands, active }  (table in play)
};

let db = null;
let flushTimer = null;

function ensureLoaded() {
	if (db) return db;
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
	if (existsSync(DB_PATH)) {
		try {
			const raw = readFileSync(DB_PATH, 'utf-8');
			db = { ...structuredClone(DEFAULT_DB), ...JSON.parse(raw) };
		} catch (e) {
			console.error('Failed to read db.json, starting fresh:', e);
			db = structuredClone(DEFAULT_DB);
		}
	} else {
		db = structuredClone(DEFAULT_DB);
		flushNow();
	}
	return db;
}

function flushNow() {
	if (!db) return;
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
	const tmp = DB_PATH + '.tmp';
	writeFileSync(tmp, JSON.stringify(db, null, '\t'));
	renameSync(tmp, DB_PATH);
}

/** Debounced persistence so bursts of writes don't thrash the disk. */
export function persist() {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		try {
			flushNow();
		} catch (e) {
			console.error('DB flush failed:', e);
		}
	}, 60);
}

export function getDb() {
	return ensureLoaded();
}

/** Run a mutation against the db and persist. */
export function mutate(fn) {
	const d = ensureLoaded();
	const result = fn(d);
	persist();
	return result;
}

export function makeId() {
	return (
		Date.now().toString(36) +
		Math.random().toString(36).slice(2, 10) +
		Math.random().toString(36).slice(2, 6)
	);
}
