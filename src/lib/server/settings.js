/**
 * Server-wide settings an admin can change while the app is running.
 *
 * There is exactly one so far — the balance a new account starts with — and the
 * bar for adding another is deliberately high: a value belongs here only if the
 * alternative is editing a constant and redeploying. Everything that is a
 * property of the GAME (the sell rate, the gold-per-dollar anchor, the bet
 * ladders) stays a constant in the shared modules, because changing one of those
 * changes the maths that the verifier scripts check.
 *
 * The default lives in economy.js and is what a database with no row returns, so
 * a fresh install behaves exactly as it did before this table existed.
 */

import { query } from './db.js';
import { STARTING_GOLD } from '../economy.js';

/**
 * In-process cache.
 *
 * Read on every registration and on the admin panel's load, written about once
 * ever. It is cached because the alternative is a query on a hot-ish path for a
 * value that changes by hand; it is invalidated by writing through this module,
 * which is the only way it is ever written. A second app process would not see
 * the other's change until its own next write — acceptable for a value an admin
 * sets once, and this app runs as a single process.
 */
const cache = new Map();

async function read(key) {
	if (cache.has(key)) return cache.get(key);
	try {
		const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
		const value = rows.length ? rows[0].value : null;
		cache.set(key, value);
		return value;
	} catch (e) {
		// A settings read must never be the reason a sign-up fails. Falling back to
		// the compiled default is always safe, because the default is what the
		// setting is for overriding.
		console.error(`settings: could not read "${key}" —`, e.message);
		return null;
	}
}

async function write(key, value) {
	await query(
		`INSERT INTO settings (key, value, at) VALUES ($1, $2::jsonb, $3)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = EXCLUDED.at`,
		[key, JSON.stringify(value), Date.now()]
	);
	cache.set(key, value);
}

/** Ceiling on the starting grant, so a fat-fingered edit cannot mint a nonsense balance. */
export const MAX_STARTING_GOLD = 1_000_000_000;

/** What a brand-new account is given. Falls back to the compiled default. */
export async function startingGold() {
	const stored = await read('startingGold');
	const n = Math.floor(Number(stored));
	if (!Number.isFinite(n) || n < 0) return STARTING_GOLD;
	return Math.min(MAX_STARTING_GOLD, n);
}

/**
 * Change the starting grant. Existing accounts are untouched — this is what the
 * NEXT registration receives, and what the database reset sets every wallet to.
 * @returns {Promise<number>} the value actually stored, after clamping
 */
export async function setStartingGold(amount) {
	const n = Math.floor(Number(amount));
	if (!Number.isFinite(n)) throw new Error('Starting gold must be a number.');
	if (n < 0) throw new Error('Starting gold cannot be negative.');
	const clamped = Math.min(MAX_STARTING_GOLD, n);
	await write('startingGold', clamped);
	return clamped;
}

/** The compiled default, for the panel to show as "back to stock". */
export const DEFAULT_STARTING_GOLD = STARTING_GOLD;
