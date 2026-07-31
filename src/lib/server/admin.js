/**
 * Admin actions — every privileged operation in one dispatch table.
 *
 * Two callers share it: the /admin panel (authenticated by an admin's session
 * cookie) and scripts/admin.mjs (authenticated by ADMIN_TOKEN). Both arrive
 * through POST /api/admin, so a command and a button do exactly the same thing
 * and there is one place to audit.
 *
 * The CLI talks HTTP rather than connecting to Postgres directly. That is now a
 * choice rather than a necessity — it used to be the only way a change could
 * stick, because the app held the whole database in memory and would overwrite
 * any outside edit — and it is still the right one: it means the CLI needs no
 * database credentials, gets the same validation as the panel, and lands in the
 * same audit log.
 */

import { timingSafeEqual } from 'node:crypto';
import { query, tx, lockGold, setGold, lockStats, writeStats, makeId, dbStatus } from './db.js';
import { MARKET_GOLD_SQL } from './economySql.js';
import {
	isAdminUser,
	envAdminNames,
	newStats,
	setPassword,
	revokeSessions,
	rowToUser,
	MIN_PASSWORD
} from './auth.js';
import { setEntry, storeSets } from './registry.js';
import { packTypeById } from '../packs.js';
import { STARTING_GOLD } from '../economy.js';
import { versionInfo } from './version.js';
import { addPacks, getStats, getOpenings, packPriceGold, MAX_BUY_PACKS } from './game.js';

/**
 * Shared secret for the CLI, from the container's environment. Unset means
 * token auth is off entirely and the panel (a signed-in admin) is the only way
 * in — an absent secret must never behave like a blank one that matches.
 */
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '');

/** Whether the CLI can be used at all on this deployment. */
export function tokenAuthEnabled() {
	return ADMIN_TOKEN.length > 0;
}

/** Constant-time comparison of a presented bearer token. */
export function verifyAdminToken(presented) {
	if (!ADMIN_TOKEN) return false;
	const a = Buffer.from(String(presented || ''), 'utf-8');
	const b = Buffer.from(ADMIN_TOKEN, 'utf-8');
	// timingSafeEqual throws outright on a length mismatch, so that case has to be
	// answered before it is reached. The length of a rejected token is not a
	// secret; its contents are, and those are only ever compared in constant time.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Ceiling on a wallet, so a fat-fingered grant cannot produce a nonsense balance. */
export const MAX_GOLD = 1_000_000_000_000;

/** How many audit entries are kept. */
const LOG_LIMIT = 300;

// ── Lookups ────────────────────────────────────────────────────

/** Find an account by username (case-insensitive) or by id. */
export async function resolveUser(ref) {
	const key = String(ref || '').trim();
	if (!key) return null;
	// One statement for both forms. The username match is tried first so that an
	// account literally named after another account's id cannot shadow it.
	const { rows } = await query(
		`SELECT * FROM users WHERE username_key = $1 OR id = $2
		  ORDER BY (username_key = $1) DESC LIMIT 1`,
		[key.toLowerCase(), key]
	);
	return rowToUser(rows[0]);
}

/**
 * The users table for the panel, as ONE query.
 *
 * This is the change with the largest measurable effect in the whole port. The
 * old version called a per-user helper that made eight separate lookups, and two
 * of those — the card count and the collection value — walked every card the
 * player owned. Rendering the panel therefore touched every card in the database:
 * at 71 accounts and 3,153 cards it was already the slowest page in the app, and
 * it grew with the square of nothing useful.
 *
 * @param {string|null} onlyUserId restrict to one account, for the detail view
 */
async function userRows(onlyUserId = null) {
	const { rows } = await query(
		`SELECT u.id, u.username, u.admin, u.created_at,
		        COALESCE(w.gold, 0)                              AS gold,
		        COALESCE(c.cards, 0)                             AS cards,
		        COALESCE(c.value, 0)                             AS collection_value,
		        COALESCE(i.packs, 0)                             AS packs,
		        COALESCE((s.data->>'packsOpened')::bigint, 0)    AS packs_opened,
		        COALESCE((s.data->>'slotSpins')::bigint, 0)      AS slot_spins,
		        COALESCE(se.n, 0)                                AS sessions,
		        COALESCE(se.last_seen, 0)                        AS last_seen_at,
		        (b.user_id IS NOT NULL)                          AS at_table,
		        COALESCE(f.remaining, 0)                         AS free_spins
		   FROM users u
		   LEFT JOIN wallets w ON w.user_id = u.id
		   LEFT JOIN (
		         SELECT user_id, count(*)::int AS cards,
		                COALESCE(SUM(${MARKET_GOLD_SQL}), 0)::bigint AS value
		           FROM collections GROUP BY user_id
		        ) c ON c.user_id = u.id
		   LEFT JOIN (
		         SELECT user_id, count(*)::int AS packs FROM inventory GROUP BY user_id
		        ) i ON i.user_id = u.id
		   LEFT JOIN stats s ON s.user_id = u.id
		   LEFT JOIN (
		         SELECT user_id, count(*)::int AS n, max(created_at) AS last_seen
		           FROM sessions GROUP BY user_id
		        ) se ON se.user_id = u.id
		   LEFT JOIN blackjack b ON b.user_id = u.id
		   LEFT JOIN free_spins f ON f.user_id = u.id
		  WHERE $1::text IS NULL OR u.id = $1
		  ORDER BY gold DESC`,
		[onlyUserId]
	);

	const envAdmins = envAdminNames();
	return rows.map((r) => ({
		id: r.id,
		username: r.username,
		admin: isAdminUser({ username: r.username, admin: r.admin }),
		// Named in ADMIN_USERNAMES, so the flag is not the panel's to revoke — the
		// same condition actionAdmin() refuses on, not an approximation of it.
		envAdmin: envAdmins.includes(r.username.toLowerCase()),
		createdAt: r.created_at || 0,
		gold: r.gold,
		cards: r.cards,
		packs: r.packs,
		collectionValue: r.collection_value,
		packsOpened: r.packs_opened,
		slotSpins: r.slot_spins,
		sessions: r.sessions,
		lastSeenAt: r.last_seen_at,
		atTable: r.at_table,
		freeSpins: r.free_spins
	}));
}

export async function listUsers() {
	return userRows();
}

async function userRow(userId) {
	return (await userRows(userId))[0] || null;
}

/** Server-wide figures for the top of the panel. */
export async function summary() {
	// Scalar subqueries in one round trip rather than a loop over every account.
	const { rows } = await query(
		`SELECT (SELECT count(*)::int FROM users)                        AS users,
		        (SELECT count(*)::int FROM users
		          WHERE admin OR username_key = ANY($1::text[]))         AS admins,
		        (SELECT count(*)::int FROM sessions)                     AS sessions,
		        (SELECT COALESCE(SUM(gold), 0)::bigint FROM wallets)     AS gold,
		        (SELECT count(*)::int FROM collections)                  AS cards,
		        (SELECT count(*)::int FROM inventory)                    AS packs,
		        (SELECT count(*)::int FROM serials)                      AS serials_issued,
		        (SELECT count(*)::int FROM blackjack)                    AS tables_open`,
		[envAdminNames()]
	);
	const r = rows[0];

	return {
		users: r.users,
		admins: r.admins,
		envAdmins: envAdminNames(),
		sessions: r.sessions,
		gold: r.gold,
		cards: r.cards,
		packs: r.packs,
		serialsIssued: r.serials_issued,
		tablesOpen: r.tables_open,
		uptimeSeconds: Math.round(process.uptime()),
		nodeVersion: process.version,
		// What is actually running here — see version.js for why this cannot just
		// be read off the image tag.
		version: versionInfo(),
		tokenAuth: tokenAuthEnabled(),
		// Which database this is, how big it is, and whether the pool is healthy.
		storage: await dbStatus()
	};
}

export async function auditLog(limit = 50) {
	const { rows } = await query('SELECT * FROM admin_log ORDER BY at DESC LIMIT $1', [
		Math.max(1, Math.min(LOG_LIMIT, Number(limit) || 50))
	]);
	return rows.map((r) => ({
		id: r.id,
		at: r.at,
		actor: r.actor,
		via: r.via,
		action: r.action,
		target: r.target,
		detail: r.detail
	}));
}

/** Sets and their products, for the panel's pack-grant picker. */
export function grantableSets() {
	return storeSets()
		.filter((s) => !s.unreleased)
		.map((s) => ({ code: s.code, name: s.name, packTypes: s.packTypes || [] }));
}

// ── Audit ──────────────────────────────────────────────────────

async function record(actor, action, target, detail) {
	await query(
		`INSERT INTO admin_log (id, at, actor, via, action, target, detail)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[makeId(), Date.now(), actor?.name || 'unknown', actor?.via || 'panel', action, target || null, detail || null]
	);
	// Trim to the cap. Cheap because admin_log_at_idx makes the cut-off a scan of
	// exactly LOG_LIMIT rows.
	await query(
		`DELETE FROM admin_log WHERE id NOT IN (
		   SELECT id FROM admin_log ORDER BY at DESC, id DESC LIMIT $1
		 )`,
		[LOG_LIMIT]
	);
}

// ── Actions ────────────────────────────────────────────────────
//
// Each takes (actor, args) and returns { ok, ... } or { ok: false, error }.
// `actor` is { name, via, id } — id is null for a token-authenticated CLI call.

async function withUser(args, fn) {
	const user = await resolveUser(args.user ?? args.username ?? args.id);
	if (!user) return { ok: false, error: `No account matching "${args.user ?? args.username ?? ''}".` };
	return fn(user);
}

/** Add to (or set) a wallet. */
function actionGold(actor, args) {
	return withUser(args, async (user) => {
		const amount = Math.round(Number(args.amount));
		if (!Number.isFinite(amount)) return { ok: false, error: 'Amount must be a number.' };

		const moved = await tx(async (client) => {
			const before = (await lockGold(client, user.id)) ?? 0;
			const after = Math.max(0, Math.min(MAX_GOLD, args.set ? amount : before + amount));

			await client.query(
				`INSERT INTO wallets (user_id, gold) VALUES ($1, $2)
				 ON CONFLICT (user_id) DO UPDATE SET gold = EXCLUDED.gold`,
				[user.id, after]
			);

			// Admin gold is not earnings. Folding it into stats.goldEarned would make
			// the player's own net-profit figure a lie, so it is only in the audit log.
			const s = await lockStats(client, user.id);
			s.adminGranted = (s.adminGranted || 0) + (after - before);
			await writeStats(client, user.id, s);

			return { before, after };
		});

		await record(actor, 'gold', user.username, `${moved.before} → ${moved.after}`);
		return {
			ok: true,
			user: user.username,
			before: moved.before,
			after: moved.after,
			delta: moved.after - moved.before
		};
	});
}

/** Drop unopened packs straight into a vault, no charge. */
function actionPacks(actor, args) {
	return withUser(args, async (user) => {
		const setCode = String(args.setCode || '').toLowerCase();
		const set = setEntry(setCode);
		if (!set) return { ok: false, error: `Unknown set "${args.setCode}".` };
		if (set.unreleased) return { ok: false, error: 'That set is not released yet.' };

		const packTypeId = String(args.packTypeId || '');
		if (!packTypeById(packTypeId)) return { ok: false, error: `Unknown pack type "${packTypeId}".` };
		if (!(set.packTypes || []).includes(packTypeId)) {
			return {
				ok: false,
				error: `${set.code.toUpperCase()} has no ${packTypeId} booster — it offers ${(set.packTypes || []).join(', ') || 'nothing'}.`
			};
		}

		const qty = Math.floor(Number(args.qty ?? 1));
		if (!(qty >= 1)) return { ok: false, error: 'Quantity must be at least 1.' };
		// Same ceiling as a purchase, so a grant cannot be a way around it.
		if (qty > MAX_BUY_PACKS) {
			return { ok: false, error: `That is over the ${MAX_BUY_PACKS.toLocaleString()}-pack limit for one grant.` };
		}

		await tx((client) => addPacks(client, user.id, setCode, packTypeId, qty, Date.now()));

		await record(actor, 'packs', user.username, `${qty}× ${set.code.toUpperCase()} ${packTypeId}`);
		const { rows } = await query(
			'SELECT count(*)::int AS n FROM inventory WHERE user_id = $1',
			[user.id]
		);
		return {
			ok: true,
			user: user.username,
			granted: qty,
			setCode,
			packTypeId,
			worth: packPriceGold(set, packTypeId) * qty,
			packs: rows[0].n
		};
	});
}

/** Grant or revoke admin. */
function actionAdmin(actor, args) {
	return withUser(args, async (user) => {
		const value = args.value === undefined ? true : !!args.value;

		if (!value && actor.id === user.id) {
			return { ok: false, error: 'Refusing to remove your own admin — you would lock yourself out.' };
		}
		if (!value && envAdminNames().includes(user.username.toLowerCase())) {
			return {
				ok: false,
				error: `${user.username} is an admin because ADMIN_USERNAMES says so. Remove them from that variable and restart.`
			};
		}
		if (!value) {
			const { rows } = await query(
				`SELECT count(*)::int AS n FROM users
				  WHERE id <> $1 AND (admin OR username_key = ANY($2::text[]))`,
				[user.id, envAdminNames()]
			);
			if (!rows[0].n) {
				return { ok: false, error: 'Refusing to remove the last admin.' };
			}
		}

		await query('UPDATE users SET admin = $2 WHERE id = $1', [user.id, value]);

		await record(actor, value ? 'admin.grant' : 'admin.revoke', user.username, null);
		return { ok: true, user: user.username, admin: value };
	});
}

/** Set a password. Signs the account out everywhere, since the credential changed. */
function actionPassword(actor, args) {
	return withUser(args, async (user) => {
		try {
			await setPassword(user.id, String(args.password || ''));
		} catch (e) {
			return { ok: false, error: e.message || `Password must be at least ${MIN_PASSWORD} characters.` };
		}
		const dropped = await revokeSessions(user.id);
		await record(actor, 'password', user.username, `${dropped} session(s) revoked`);
		return { ok: true, user: user.username, sessionsRevoked: dropped };
	});
}

/** Sign an account out of every device. */
function actionLogout(actor, args) {
	return withUser(args, async (user) => {
		const dropped = await revokeSessions(user.id);
		await record(actor, 'logout', user.username, `${dropped} session(s)`);
		return { ok: true, user: user.username, sessionsRevoked: dropped };
	});
}

/** Zero the statistics, keeping the account, wallet and cards. */
function actionResetStats(actor, args) {
	return withUser(args, async (user) => {
		await tx(async (client) => {
			await lockStats(client, user.id);
			await writeStats(client, user.id, newStats());
		});
		await record(actor, 'stats.reset', user.username, null);
		return { ok: true, user: user.username };
	});
}

/**
 * Clear a wedged game. A blackjack hand or a free-spin round is server-side
 * state the player cannot escape from the UI if it ever ends up inconsistent —
 * this is the reset for that, and it refunds nothing.
 */
function actionUnstick(actor, args) {
	return withUser(args, async (user) => {
		const had = await tx(async (client) => {
			const { rowCount: table } = await client.query(
				'DELETE FROM blackjack WHERE user_id = $1',
				[user.id]
			);
			const { rows: fs } = await client.query(
				'DELETE FROM free_spins WHERE user_id = $1 RETURNING remaining',
				[user.id]
			);
			return { table: table > 0, freeSpins: fs[0]?.remaining || 0 };
		});
		await record(actor, 'unstick', user.username, `table=${had.table} freeSpins=${had.freeSpins}`);
		return { ok: true, user: user.username, cleared: had };
	});
}

/** Delete an account and everything attached to it. */
function actionDelete(actor, args) {
	return withUser(args, async (user) => {
		if (!args.confirm) {
			return { ok: false, error: `Deleting ${user.username} is permanent — pass confirm to go ahead.` };
		}
		if (actor.id === user.id) {
			return { ok: false, error: 'Refusing to delete the account you are signed in as.' };
		}

		// Read the figures for the audit entry before the rows go away.
		const row = await userRow(user.id);

		// One DELETE. Sessions, wallet, inventory, collection, stats, openings, the
		// blackjack table and any free spins all have ON DELETE CASCADE, so this is
		// the whole teardown and it cannot leave half an account behind.
		//
		// `serials` is deliberately NOT among them: it has no foreign key to users at
		// all. A serialized card is a physical object with a finite print run, and
		// releasing #137/250 back into the pool because its owner left would let a
		// second one exist.
		await query('DELETE FROM users WHERE id = $1', [user.id]);

		await record(
			actor,
			'delete',
			user.username,
			`${row?.cards ?? 0} cards, ${row?.packs ?? 0} packs, ${row?.gold ?? 0} gold`
		);
		return { ok: true, user: user.username, removed: row };
	});
}

// ── Reads, as actions (so the CLI can ask for them too) ────────

async function actionOverview() {
	const [s, users, log] = await Promise.all([summary(), listUsers(), auditLog(30)]);
	return { ok: true, summary: s, users, log };
}

async function actionUsers() {
	return { ok: true, users: await listUsers() };
}

function actionUser(actor, args) {
	return withUser(args, async (user) => {
		const [row, stats, openings] = await Promise.all([
			userRow(user.id),
			getStats(user.id),
			getOpenings(user.id)
		]);
		return { ok: true, user: { ...row, stats, openings: openings.slice(0, 5) } };
	});
}

async function actionLog(actor, args) {
	return { ok: true, log: await auditLog(args.limit ?? 50) };
}

/** The word a caller has to send to prove a database reset is deliberate. */
export const RESET_CONFIRM = 'RESET';

/**
 * Wipe every player's progress, keeping the accounts themselves.
 *
 * Collections, vaults, rip histories, stats, blackjack tables and free spins all
 * go, and every wallet returns to the starting balance. Accounts, passwords and
 * sessions survive, so nobody is logged out and nobody has to register again —
 * everyone simply starts over. admin_log survives too, because the entry saying
 * this happened is the one you most want afterwards.
 *
 * `serials` IS cleared here, which is the opposite of what deleting one account
 * does, and the difference is the point. Releasing #137/250 when its owner leaves
 * would let a second one exist alongside the first; releasing it when every card
 * in the database is being destroyed leaves nothing for it to duplicate. The
 * ledger is only meaningful next to the cards it was issued to, and after this
 * there are none.
 *
 * TRUNCATE rather than DELETE: nothing has a foreign key pointing AT these
 * tables, so there is no cascade to worry about, and it does not care how many
 * rows it is removing — the point of this button is a database that has had
 * 300,000 cards ripped into it.
 */
async function actionResetDatabase(actor, args) {
	if (String(args.confirm || '') !== RESET_CONFIRM) {
		return {
			ok: false,
			error: `This wipes every player's cards, packs, stats and gold. Send confirm="${RESET_CONFIRM}" to go ahead.`
		};
	}

	// The figures for the audit entry, read before they stop existing.
	const before = await summary();

	await tx(async (client) => {
		await client.query(
			'TRUNCATE collections, inventory, openings, stats, blackjack, free_spins, serials'
		);
		// Not TRUNCATE: the row per account has to stay, at the balance a new
		// account starts with. A player with no wallet row reads as zero gold and
		// could not buy their first pack.
		await client.query('UPDATE wallets SET gold = $1', [STARTING_GOLD]);
	});

	await record(
		actor,
		'db.reset',
		null,
		`wiped ${before.cards} cards, ${before.packs} packs, ${before.serialsIssued} serials across ` +
			`${before.users} account(s); wallets set to ${STARTING_GOLD}`
	);

	return {
		ok: true,
		accountsKept: before.users,
		cardsWiped: before.cards,
		packsWiped: before.packs,
		serialsReleased: before.serialsIssued,
		goldEach: STARTING_GOLD
	};
}

/**
 * The dispatch table. Action names are the CLI's vocabulary and the panel's
 * button wiring both — adding an entry here is the whole job of adding a command.
 */
const HANDLERS = {
	overview: actionOverview,
	users: actionUsers,
	user: actionUser,
	log: actionLog,
	gold: actionGold,
	packs: actionPacks,
	admin: actionAdmin,
	password: actionPassword,
	logout: actionLogout,
	'reset-stats': actionResetStats,
	unstick: actionUnstick,
	delete: actionDelete,
	'db-reset': actionResetDatabase
};

export const ACTION_NAMES = Object.keys(HANDLERS);

/**
 * Run one admin action.
 * @param {{name:string, via:'panel'|'cli', id:string|null}} actor
 * @param {string} action
 * @param {object} args
 */
export async function runAdminAction(actor, action, args = {}) {
	const handler = HANDLERS[String(action || '')];
	if (!handler) {
		return { ok: false, error: `Unknown action "${action}". Try one of: ${ACTION_NAMES.join(', ')}.` };
	}
	try {
		return await handler(actor, args);
	} catch (e) {
		console.error(`admin action ${action} failed:`, e);
		return { ok: false, error: e?.message || 'The action failed.' };
	}
}
