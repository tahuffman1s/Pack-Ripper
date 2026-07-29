import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb, mutate, makeId } from './db.js';
import { STARTING_GOLD } from '../economy.js';

export const SESSION_COOKIE = 'ripper_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function hashPassword(password, salt) {
	return scryptSync(password, salt, 64).toString('hex');
}

export function createUser({ username, email, password }) {
	username = String(username || '').trim();
	email = String(email || '').trim();
	const key = username.toLowerCase();

	if (username.length < 3 || username.length > 20) {
		throw new Error('Username must be 3–20 characters.');
	}
	if (!/^[a-zA-Z0-9_]+$/.test(username)) {
		throw new Error('Username may only contain letters, numbers and underscores.');
	}
	if (String(password || '').length < 6) {
		throw new Error('Password must be at least 6 characters.');
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
		d.users[id] = { id, username, email, passwordHash, salt, createdAt: now };
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
	return { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt };
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
