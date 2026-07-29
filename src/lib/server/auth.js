import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb, mutate, makeId } from './db.js';
import { STARTING_GOLD } from '../economy.js';

export const SESSION_COOKIE = 'ripper_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const MIN_PASSWORD = 6;

/**
 * Accounts that are admins because the environment says so, regardless of what
 * is stored on them. This is the bootstrap: a brand-new database has no admins
 * and nothing in the UI can promote the first one, so
 * `ADMIN_USERNAMES=travis,someone` on the container promotes them at sign-in —
 * before the account exists, if you like. Everyone else is promoted from the
 * panel, which sets `admin: true` on the user record.
 */
const ENV_ADMINS = new Set(
	String(process.env.ADMIN_USERNAMES || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
);

/** Whether a stored user record is an admin. */
export function isAdminUser(user) {
	if (!user) return false;
	return user.admin === true || ENV_ADMINS.has(String(user.username || '').toLowerCase());
}

/** Admins named by the environment, so the panel can say the flag is not editable. */
export function envAdminNames() {
	return [...ENV_ADMINS];
}

function hashPassword(password, salt) {
	return scryptSync(password, salt, 64).toString('hex');
}

export function createUser({ username, password }) {
	username = String(username || '').trim();
	const key = username.toLowerCase();

	if (username.length < 3 || username.length > 20) {
		throw new Error('Username must be 3–20 characters.');
	}
	if (!/^[a-zA-Z0-9_]+$/.test(username)) {
		throw new Error('Username may only contain letters, numbers and underscores.');
	}
	if (String(password || '').length < MIN_PASSWORD) {
		throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
	}

	const db = getDb();
	if (db.usernames[key]) {
		throw new Error('That username is already taken.');
	}

	const id = makeId();
	const salt = randomBytes(16).toString('hex');
	const passwordHash = hashPassword(password, salt);
	const now = Date.now();

	mutate((d) => {
		d.users[id] = { id, username, passwordHash, salt, createdAt: now };
		d.usernames[key] = id;
		d.wallets[id] = { gold: STARTING_GOLD };
		d.inventory[id] = [];
		d.collections[id] = [];
		d.stats[id] = newStats();
		d.openings[id] = [];
	});

	return db.users[id];
}

export function newStats() {
	return {
		packsOpened: 0,
		boxesOpened: 0,
		cardsOpened: 0,
		goldSpent: 0,
		goldEarned: 0,
		cardsSold: 0,
		packsSold: 0,
		mythicsPulled: 0,
		raresPulled: 0,
		foilsPulled: 0,
		bestPull: null, // { name, set, gold, image }
		bySet: {}, // setCode -> packs opened
		slotSpins: 0,
		slotWagered: 0,
		slotWon: 0,
		slotBest: null // { win, line, label, at }
	};
}

export function verifyUser(username, password) {
	const db = getDb();
	const id = db.usernames[String(username || '').trim().toLowerCase()];
	if (!id) return null;
	const user = db.users[id];
	if (!user) return null;
	const attempt = hashPassword(password, user.salt);
	const a = Buffer.from(attempt, 'hex');
	const b = Buffer.from(user.passwordHash, 'hex');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return user;
}

/**
 * Replace an account's password, salt and all. Used by the admin panel and the
 * admin CLI; hashing stays in this module so there is exactly one place that
 * knows how a stored credential is derived.
 */
export function setPassword(userId, password) {
	if (String(password || '').length < MIN_PASSWORD) {
		throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
	}
	const salt = randomBytes(16).toString('hex');
	const passwordHash = hashPassword(password, salt);
	mutate((d) => {
		const user = d.users[userId];
		if (!user) throw new Error('No such account.');
		user.salt = salt;
		user.passwordHash = passwordHash;
	});
}

/** Drop every session belonging to a user — signs them out everywhere. */
export function revokeSessions(userId) {
	let n = 0;
	mutate((d) => {
		for (const [token, s] of Object.entries(d.sessions)) {
			if (s.userId === userId) {
				delete d.sessions[token];
				n++;
			}
		}
	});
	return n;
}

export function createSession(userId) {
	const token = randomBytes(32).toString('hex');
	mutate((d) => {
		d.sessions[token] = { userId, createdAt: Date.now() };
	});
	return token;
}

export function destroySession(token) {
	if (!token) return;
	mutate((d) => {
		delete d.sessions[token];
	});
}

export function getUserFromSession(token) {
	if (!token) return null;
	const db = getDb();
	const session = db.sessions[token];
	if (!session) return null;
	const user = db.users[session.userId];
	if (!user) return null;
	return {
		id: user.id,
		username: user.username,
		createdAt: user.createdAt,
		admin: isAdminUser(user)
	};
}

export function sessionCookieOptions() {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_MAX_AGE
	};
}
