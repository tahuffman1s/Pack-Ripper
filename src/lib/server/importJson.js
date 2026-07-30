import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tx, query, noteImport } from './db.js';
import { COLLECTION_COLUMNS, cardToValues, valuesClause } from './rows.js';

/**
 * One-shot migration of the old file-backed database into Postgres.
 *
 * This runs automatically at boot, and the guard is the whole design: it does
 * nothing unless Postgres has ZERO accounts. It can therefore only ever add data
 * to an empty database, never overwrite a populated one, which is what makes it
 * safe to leave switched on forever rather than being a step someone has to
 * remember to run exactly once.
 *
 * That guard is deliberately the opposite shape to the one the old db.js needed.
 * The old file had to reason about whether an absent database meant "first boot"
 * or "the volume is not mounted yet", because it was about to WRITE, and guessing
 * wrong destroyed 71 accounts. Nothing here can destroy anything: the worst
 * outcome of a wrong guess is that an import does not happen, and the fix for
 * that is to restart with the file present.
 *
 * Everything lands in ONE transaction. A partial import is the one bad outcome
 * available to this code, so it is not available: either every account arrives or
 * the database is still empty and the log says why.
 */

const DATA_DIR = join(process.cwd(), '.data');

/** Where to look, in preference order — the same candidates the old loader used. */
const CANDIDATES = [
	join(DATA_DIR, 'db.json'),
	join(DATA_DIR, 'db.json.bak'),
	join(DATA_DIR, 'db.json.tmp')
];

/** Rows per INSERT. See INSERT_CHUNK in game.js for the parameter-limit reasoning. */
const CHUNK = 500;

function readCandidate(path) {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8'));
		// A file that parses but has no users map is not a database — most likely a
		// half-written one that happened to land on valid syntax.
		if (!parsed || typeof parsed !== 'object' || !parsed.users) return null;
		if (!Object.keys(parsed.users).length) return null;
		return parsed;
	} catch (e) {
		console.error(`import: ${path} is unreadable — ${e.message}`);
		return null;
	}
}

/** Insert rows in chunks. `toValues` maps one item to a parameter tuple. */
async function insertChunked(client, table, columns, items, toValues) {
	for (let i = 0; i < items.length; i += CHUNK) {
		const batch = items.slice(i, i + CHUNK);
		await client.query(
			`INSERT INTO ${table} (${columns.join(', ')})
			 VALUES ${valuesClause(batch.length, columns.length)}
			 ON CONFLICT DO NOTHING`,
			batch.flatMap(toValues)
		);
	}
}

/**
 * Import if and only if the database is empty and a legacy file exists.
 * @returns {Promise<object|null>} a summary, or null if nothing was done
 */
export async function importLegacyJson() {
	const { rows } = await query('SELECT count(*)::int AS n FROM users');
	if (rows[0].n > 0) return null;

	let source = null;
	let db = null;
	for (const path of CANDIDATES) {
		db = readCandidate(path);
		if (db) {
			source = path;
			break;
		}
	}
	if (!db) return null;

	console.log(`import: empty database and ${source} holds accounts — importing`);

	const counts = await tx(async (client) => {
		const users = Object.values(db.users || {});

		// Users first: everything else has a foreign key to them, and rows whose
		// owner is missing from the file are dropped rather than imported orphaned.
		await insertChunked(
			client,
			'users',
			['id', 'username', 'username_key', 'password_hash', 'salt', 'created_at', 'admin'],
			users,
			(u) => [
				u.id,
				u.username,
				String(u.username || '').toLowerCase(),
				u.passwordHash,
				u.salt,
				u.createdAt || Date.now(),
				u.admin === true
			]
		);
		const known = new Set(users.map((u) => u.id));
		const owned = (id) => known.has(id);

		// Wallets. A player with no wallet entry gets a zero one rather than no row,
		// because every money path expects the row to exist and reports its absence
		// as an error.
		await insertChunked(
			client,
			'wallets',
			['user_id', 'gold'],
			users,
			(u) => [u.id, Math.max(0, Math.round(db.wallets?.[u.id]?.gold ?? 0))]
		);

		await insertChunked(
			client,
			'stats',
			['user_id', 'data'],
			users,
			(u) => [u.id, JSON.stringify(db.stats?.[u.id] ?? {})]
		);

		const sessions = Object.entries(db.sessions || {}).filter(([, s]) => owned(s?.userId));
		await insertChunked(client, 'sessions', ['token', 'user_id', 'created_at'], sessions, ([
			token,
			s
		]) => [token, s.userId, s.createdAt || Date.now()]);

		const packs = [];
		for (const [userId, list] of Object.entries(db.inventory || {})) {
			if (!owned(userId)) continue;
			for (const item of list || []) packs.push([userId, item]);
		}
		await insertChunked(
			client,
			'inventory',
			['id', 'user_id', 'set_code', 'pack_type_id', 'acquired_at'],
			packs,
			([userId, item]) => [
				item.id,
				userId,
				item.setCode,
				item.packTypeId,
				item.acquiredAt || Date.now()
			]
		);

		// Cards go through exactly the same mapper the running app writes with, so
		// an imported card and a freshly pulled one are the same row shape.
		const cards = [];
		for (const [userId, list] of Object.entries(db.collections || {})) {
			if (!owned(userId)) continue;
			for (const c of list || []) cards.push([userId, c]);
		}
		await insertChunked(client, 'collections', COLLECTION_COLUMNS, cards, ([userId, c]) =>
			cardToValues(userId, c)
		);

		const openings = [];
		for (const [userId, list] of Object.entries(db.openings || {})) {
			if (!owned(userId)) continue;
			for (const o of list || []) openings.push([userId, o]);
		}
		await insertChunked(
			client,
			'openings',
			['id', 'user_id', 'at', 'set_code', 'set_name', 'pack_type_id', 'card_count', 'value_gold'],
			openings,
			([userId, o]) => [
				o.id,
				userId,
				o.at || Date.now(),
				o.setCode,
				o.setName ?? null,
				o.packTypeId,
				o.cardCount || 0,
				Math.round(o.valueGold || 0)
			]
		);

		// The serial ledger. NOT filtered by owner — a serial is issued against a
		// print run, not against an account, and one that was issued to an account
		// that has since gone must stay issued.
		const serials = [];
		for (const [scryfallId, list] of Object.entries(db.serials || {})) {
			for (const n of list || []) serials.push([scryfallId, n]);
		}
		await insertChunked(
			client,
			'serials',
			['scryfall_id', 'n', 'issued_at'],
			serials,
			([scryfallId, n]) => [scryfallId, n, Date.now()]
		);

		const tables = Object.entries(db.blackjack || {}).filter(([userId]) => owned(userId));
		await insertChunked(client, 'blackjack', ['user_id', 'state'], tables, ([userId, state]) => [
			userId,
			JSON.stringify(state)
		]);

		const spins = Object.entries(db.freeSpins || {}).filter(
			([userId, fs]) => owned(userId) && fs?.remaining > 0
		);
		await insertChunked(
			client,
			'free_spins',
			['user_id', 'remaining', 'line_bet', 'lines'],
			spins,
			([userId, fs]) => [userId, fs.remaining, fs.lineBet, fs.lines]
		);

		const log = (db.adminLog || []).filter((e) => e?.id);
		await insertChunked(
			client,
			'admin_log',
			['id', 'at', 'actor', 'via', 'action', 'target', 'detail'],
			log,
			(e) => [e.id, e.at || Date.now(), e.actor ?? null, e.via ?? null, e.action, e.target ?? null, e.detail ?? null]
		);

		return {
			users: users.length,
			sessions: sessions.length,
			packs: packs.length,
			cards: cards.length,
			openings: openings.length,
			serials: serials.length,
			tables: tables.length,
			freeSpins: spins.length,
			adminLog: log.length
		};
	});

	// Read the counts back out of the database rather than reporting what was sent.
	// "I inserted 3,153 cards" is what the importer believes; "there are 3,153 rows
	// in collections" is what actually happened, and only one of those is worth
	// printing after a migration.
	const { rows: verified } = await query(
		`SELECT (SELECT count(*)::int FROM users)       AS users,
		        (SELECT count(*)::int FROM collections) AS cards,
		        (SELECT count(*)::int FROM inventory)   AS packs,
		        (SELECT count(*)::int FROM serials)     AS serials,
		        (SELECT COALESCE(SUM(gold),0)::bigint FROM wallets) AS gold`
	);
	const v = verified[0];

	const summary = { source, sent: counts, inDatabase: v, at: Date.now() };
	noteImport(summary);

	console.log(
		`import: done — ${v.users} account(s), ${v.cards} card(s), ${v.packs} pack(s), ` +
			`${v.serials} serial(s), ${v.gold.toLocaleString('en-US')} gold. ` +
			`Source left untouched at ${source}.`
	);
	if (counts.cards !== v.cards || counts.users !== v.users) {
		console.error(
			`import: WARNING — sent ${counts.users} users / ${counts.cards} cards but the database ` +
				`holds ${v.users} / ${v.cards}. Duplicate ids in the source file are the likely cause ` +
				'(the inserts skip conflicts rather than failing).'
		);
	}

	return summary;
}
