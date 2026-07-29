/**
 * Admin actions — every privileged operation in one dispatch table.
 *
 * Two callers share it: the /admin panel (authenticated by an admin's session
 * cookie) and scripts/admin.mjs (authenticated by ADMIN_TOKEN). Both arrive
 * through POST /api/admin, so a command and a button do exactly the same thing
 * and there is one place to audit.
 *
 * The CLI deliberately talks HTTP rather than editing .data/db.json. db.js keeps
 * the whole database in memory and writes all of it back on every mutation, so a
 * second process editing the file would have its work silently overwritten by
 * the next thing a player did. Going through the running app is the only way a
 * change sticks.
 */

import { timingSafeEqual } from 'node:crypto';
import { getDb, mutate, makeId, dbStatus } from './db.js';
import {
	isAdminUser,
	envAdminNames,
	newStats,
	setPassword,
	revokeSessions,
	MIN_PASSWORD
} from './auth.js';
import { setEntry, storeSets } from './registry.js';
import { packTypeById } from '../packs.js';
import {
	getWallet,
	getInventory,
	getCollection,
	getStats,
	collectionValue,
	packPriceGold,
	MAX_BUY_PACKS
} from './game.js';

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
export function resolveUser(ref) {
	const db = getDb();
	const key = String(ref || '').trim();
	if (!key) return null;
	const byName = db.usernames[key.toLowerCase()];
	if (byName && db.users[byName]) return db.users[byName];
	return db.users[key] || null;
}

function sessionsFor(userId) {
	const db = getDb();
	return Object.values(db.sessions).filter((s) => s.userId === userId);
}

/** One row of the users table. */
function userRow(user) {
	const sessions = sessionsFor(user.id);
	const stats = getStats(user.id);
	return {
		id: user.id,
		username: user.username,
		admin: isAdminUser(user),
		// Named in ADMIN_USERNAMES, so the flag is not the panel's to revoke — the
		// same condition actionAdmin() refuses on, not an approximation of it.
		envAdmin: envAdminNames().includes(user.username.toLowerCase()),
		createdAt: user.createdAt || 0,
		gold: getWallet(user.id).gold || 0,
		cards: getCollection(user.id).length,
		packs: getInventory(user.id).length,
		collectionValue: collectionValue(user.id),
		packsOpened: stats.packsOpened || 0,
		slotSpins: stats.slotSpins || 0,
		sessions: sessions.length,
		lastSeenAt: sessions.reduce((a, s) => Math.max(a, s.createdAt || 0), 0),
		atTable: !!getDb().blackjack?.[user.id],
		freeSpins: getDb().freeSpins?.[user.id]?.remaining || 0
	};
}

export function listUsers() {
	const db = getDb();
	return Object.values(db.users)
		.map(userRow)
		.sort((a, b) => b.gold - a.gold);
}

/** Server-wide figures for the top of the panel. */
export function summary() {
	const db = getDb();
	const users = Object.values(db.users);
	let gold = 0;
	let cards = 0;
	let packs = 0;
	for (const u of users) {
		gold += getWallet(u.id).gold || 0;
		cards += getCollection(u.id).length;
		packs += getInventory(u.id).length;
	}
	return {
		users: users.length,
		admins: users.filter(isAdminUser).length,
		envAdmins: envAdminNames(),
		sessions: Object.keys(db.sessions).length,
		gold,
		cards,
		packs,
		serialsIssued: Object.values(db.serials || {}).reduce((a, l) => a + l.length, 0),
		tablesOpen: Object.keys(db.blackjack || {}).length,
		uptimeSeconds: Math.round(process.uptime()),
		nodeVersion: process.version,
		tokenAuth: tokenAuthEnabled(),
		// Where the accounts came from on this boot. `startedEmpty` on a deployment
		// that should have data means the volume is not mounted, and is worth seeing
		// before someone registers and starts filling a database that will vanish.
		storage: dbStatus()
	};
}

export function auditLog(limit = 50) {
	const db = getDb();
	return (db.adminLog || []).slice(0, Math.max(1, Math.min(LOG_LIMIT, Number(limit) || 50)));
}

/** Sets and their products, for the panel's pack-grant picker. */
export function grantableSets() {
	return storeSets()
		.filter((s) => !s.unreleased)
		.map((s) => ({ code: s.code, name: s.name, packTypes: s.packTypes || [] }));
}

// ── Audit ──────────────────────────────────────────────────────

function record(actor, action, target, detail) {
	mutate((d) => {
		const log = (d.adminLog ??= []);
		log.unshift({
			id: makeId(),
			at: Date.now(),
			actor: actor?.name || 'unknown',
			via: actor?.via || 'panel',
			action,
			target: target || null,
			detail: detail || null
		});
		d.adminLog = log.slice(0, LOG_LIMIT);
	});
}

// ── Actions ────────────────────────────────────────────────────
//
// Each takes (actor, args) and returns { ok, ... } or { ok: false, error }.
// `actor` is { name, via, id } — id is null for a token-authenticated CLI call.

function withUser(args, fn) {
	const user = resolveUser(args.user ?? args.username ?? args.id);
	if (!user) return { ok: false, error: `No account matching "${args.user ?? args.username ?? ''}".` };
	return fn(user);
}

/** Add to (or set) a wallet. */
function actionGold(actor, args) {
	return withUser(args, (user) => {
		const amount = Math.round(Number(args.amount));
		if (!Number.isFinite(amount)) return { ok: false, error: 'Amount must be a number.' };

		const before = getWallet(user.id).gold || 0;
		const after = Math.max(0, Math.min(MAX_GOLD, args.set ? amount : before + amount));

		mutate((d) => {
			(d.wallets[user.id] ??= { gold: 0 }).gold = after;
			// Admin gold is not earnings. Folding it into stats.goldEarned would make
			// the player's own net-profit figure a lie, so it is only in the audit log.
			const s = (d.stats[user.id] ??= newStats());
			s.adminGranted = (s.adminGranted || 0) + (after - before);
		});

		record(actor, 'gold', user.username, `${before} → ${after}`);
		return { ok: true, user: user.username, before, after, delta: after - before };
	});
}

/** Drop unopened packs straight into a vault, no charge. */
function actionPacks(actor, args) {
	return withUser(args, (user) => {
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
		// Same ceiling as a purchase: every pack is its own row and the whole vault
		// is rewritten on each mutation.
		if (qty > MAX_BUY_PACKS) {
			return { ok: false, error: `That is over the ${MAX_BUY_PACKS.toLocaleString()}-pack limit for one grant.` };
		}

		const now = Date.now();
		mutate((d) => {
			const inv = (d.inventory[user.id] ??= []);
			for (let i = 0; i < qty; i++) inv.push({ id: makeId(), setCode, packTypeId, acquiredAt: now });
		});

		record(actor, 'packs', user.username, `${qty}× ${set.code.toUpperCase()} ${packTypeId}`);
		return {
			ok: true,
			user: user.username,
			granted: qty,
			setCode,
			packTypeId,
			worth: packPriceGold(set, packTypeId) * qty,
			packs: getInventory(user.id).length
		};
	});
}

/** Grant or revoke admin. */
function actionAdmin(actor, args) {
	return withUser(args, (user) => {
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
			const db = getDb();
			const remaining = Object.values(db.users).filter((u) => u.id !== user.id && isAdminUser(u));
			if (!remaining.length) {
				return { ok: false, error: 'Refusing to remove the last admin.' };
			}
		}

		mutate((d) => {
			if (value) d.users[user.id].admin = true;
			else delete d.users[user.id].admin;
		});

		record(actor, value ? 'admin.grant' : 'admin.revoke', user.username, null);
		return { ok: true, user: user.username, admin: value };
	});
}

/** Set a password. Signs the account out everywhere, since the credential changed. */
function actionPassword(actor, args) {
	return withUser(args, (user) => {
		try {
			setPassword(user.id, String(args.password || ''));
		} catch (e) {
			return { ok: false, error: e.message || `Password must be at least ${MIN_PASSWORD} characters.` };
		}
		const dropped = revokeSessions(user.id);
		record(actor, 'password', user.username, `${dropped} session(s) revoked`);
		return { ok: true, user: user.username, sessionsRevoked: dropped };
	});
}

/** Sign an account out of every device. */
function actionLogout(actor, args) {
	return withUser(args, (user) => {
		const dropped = revokeSessions(user.id);
		record(actor, 'logout', user.username, `${dropped} session(s)`);
		return { ok: true, user: user.username, sessionsRevoked: dropped };
	});
}

/** Zero the statistics, keeping the account, wallet and cards. */
function actionResetStats(actor, args) {
	return withUser(args, (user) => {
		mutate((d) => {
			d.stats[user.id] = newStats();
		});
		record(actor, 'stats.reset', user.username, null);
		return { ok: true, user: user.username };
	});
}

/**
 * Clear a wedged game. A blackjack hand or a free-spin round is server-side
 * state the player cannot escape from the UI if it ever ends up inconsistent —
 * this is the reset for that, and it refunds nothing.
 */
function actionUnstick(actor, args) {
	return withUser(args, (user) => {
		const had = {
			table: !!getDb().blackjack?.[user.id],
			freeSpins: getDb().freeSpins?.[user.id]?.remaining || 0
		};
		mutate((d) => {
			delete d.blackjack?.[user.id];
			delete d.freeSpins?.[user.id];
		});
		record(actor, 'unstick', user.username, `table=${had.table} freeSpins=${had.freeSpins}`);
		return { ok: true, user: user.username, cleared: had };
	});
}

/** Delete an account and everything attached to it. */
function actionDelete(actor, args) {
	return withUser(args, (user) => {
		if (!args.confirm) {
			return { ok: false, error: `Deleting ${user.username} is permanent — pass confirm to go ahead.` };
		}
		if (actor.id === user.id) {
			return { ok: false, error: 'Refusing to delete the account you are signed in as.' };
		}

		const row = userRow(user);
		mutate((d) => {
			delete d.users[user.id];
			delete d.usernames[user.username.toLowerCase()];
			for (const [token, s] of Object.entries(d.sessions)) {
				if (s.userId === user.id) delete d.sessions[token];
			}
			for (const bucket of ['wallets', 'inventory', 'collections', 'stats', 'openings', 'freeSpins', 'blackjack']) {
				delete d[bucket]?.[user.id];
			}
			// d.serials is deliberately untouched: a serialized card is a physical
			// object with a finite print run, and releasing #137/250 back into the
			// pool because its owner left would let a second one exist.
		});

		record(actor, 'delete', user.username, `${row.cards} cards, ${row.packs} packs, ${row.gold} gold`);
		return { ok: true, user: user.username, removed: row };
	});
}

// ── Reads, as actions (so the CLI can ask for them too) ────────

function actionOverview() {
	return { ok: true, summary: summary(), users: listUsers(), log: auditLog(30) };
}

function actionUsers() {
	return { ok: true, users: listUsers() };
}

function actionUser(actor, args) {
	return withUser(args, (user) => {
		const stats = getStats(user.id);
		const openings = (getDb().openings?.[user.id] || []).slice(0, 5);
		return { ok: true, user: { ...userRow(user), stats, openings } };
	});
}

function actionLog(actor, args) {
	return { ok: true, log: auditLog(args.limit ?? 50) };
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
	delete: actionDelete
};

export const ACTION_NAMES = Object.keys(HANDLERS);

/**
 * Run one admin action.
 * @param {{name:string, via:'panel'|'cli', id:string|null}} actor
 * @param {string} action
 * @param {object} args
 */
export function runAdminAction(actor, action, args = {}) {
	const handler = HANDLERS[String(action || '')];
	if (!handler) {
		return { ok: false, error: `Unknown action "${action}". Try one of: ${ACTION_NAMES.join(', ')}.` };
	}
	try {
		return handler(actor, args);
	} catch (e) {
		console.error(`admin action ${action} failed:`, e);
		return { ok: false, error: e?.message || 'The action failed.' };
	}
}
