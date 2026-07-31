import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { query, tx, makeId } from './db.js';
import { startingGold } from './settings.js';

export const SESSION_COOKIE = 'ripper_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE * 1000;

/**
 * How often expired session rows are swept. Six hours: the cookie already carries
 * the same lifetime, so this is housekeeping rather than enforcement — no session
 * is ever *honoured* because the sweep has not run yet (see getUserFromSession).
 */
const SWEEP_EVERY_MS = 1000 * 60 * 60 * 6;

export const MIN_PASSWORD = 6;

/** Postgres's unique_violation. Raised by the UNIQUE on users.username_key. */
const UNIQUE_VIOLATION = '23505';

/**
 * Accounts that are admins because the environment says so, regardless of what
 * is stored on them. This is the bootstrap: a brand-new database has no admins
 * and nothing in the UI can promote the first one, so
 * `ADMIN_USERNAMES=travis,someone` on the container promotes them at sign-in —
 * before the account exists, if you like. Everyone else is promoted from the
 * panel, which sets `admin = true` on the user row.
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

/**
 * One users row in the shape the rest of the app already expects. Kept in this
 * module so column names stop at the data layer and nothing downstream has to
 * know that `passwordHash` is stored as `password_hash`.
 */
export function rowToUser(row) {
	if (!row) return null;
	return {
		id: row.id,
		username: row.username,
		passwordHash: row.password_hash,
		salt: row.salt,
		createdAt: row.created_at,
		admin: row.admin === true
	};
}

function hashPassword(password, salt) {
	return scryptSync(password, salt, 64).toString('hex');
}

export async function createUser({ username, password }) {
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

	const id = makeId();
	const salt = randomBytes(16).toString('hex');
	const passwordHash = hashPassword(password, salt);
	const now = Date.now();
	// The opening balance is a setting an admin can change, not a constant — read
	// before the transaction opens, since it may be a query of its own.
	const grant = await startingGold();

	try {
		return await tx(async (client) => {
			const { rows } = await client.query(
				`INSERT INTO users (id, username, username_key, password_hash, salt, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING *`,
				[id, username, key, passwordHash, salt, now]
			);
			await client.query('INSERT INTO wallets (user_id, gold) VALUES ($1, $2)', [id, grant]);
			await client.query('INSERT INTO stats (user_id, data) VALUES ($1, $2::jsonb)', [
				id,
				JSON.stringify(newStats())
			]);
			// inventory, collections and openings need no rows: "empty" is the absence
			// of rows, not an empty array that has to be created first.
			return rowToUser(rows[0]);
		});
	} catch (e) {
		// Two people racing to claim the same name used to be settled by whichever
		// one flushed the file last, and both would appear to succeed. Now the
		// database refuses the second one and this is that refusal, phrased for a
		// person rather than as a constraint name.
		if (e?.code === UNIQUE_VIOLATION) {
			throw new Error('That username is already taken.');
		}
		throw e;
	}
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
		slotPacksWon: 0,
		slotPackGold: 0,
		slotBest: null // { win, label, pack, lineBet, lines, at }
	};
}

export async function verifyUser(username, password) {
	const { rows } = await query('SELECT * FROM users WHERE username_key = $1', [
		String(username || '').trim().toLowerCase()
	]);
	const user = rowToUser(rows[0]);
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
export async function setPassword(userId, password) {
	if (String(password || '').length < MIN_PASSWORD) {
		throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
	}
	const salt = randomBytes(16).toString('hex');
	const passwordHash = hashPassword(password, salt);
	const { rowCount } = await query(
		'UPDATE users SET salt = $2, password_hash = $3 WHERE id = $1',
		[userId, salt, passwordHash]
	);
	if (!rowCount) throw new Error('No such account.');
}

/** Drop every session belonging to a user — signs them out everywhere. */
export async function revokeSessions(userId) {
	const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
	return rowCount;
}

export async function createSession(userId) {
	const token = randomBytes(32).toString('hex');
	await query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [
		token,
		userId,
		Date.now()
	]);
	return token;
}

export async function destroySession(token) {
	if (!token) return;
	await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function getUserFromSession(token) {
	if (!token) return null;
	// One query rather than a session lookup followed by a user lookup. This runs
	// on EVERY request through hooks.server.js, so it is the hottest statement in
	// the app and the only one worth being deliberate about.
	//
	// The age test is here, not left to the sweep, and that distinction is the
	// point: the cookie's own Max-Age only governs whether a *browser* keeps
	// sending the token. A token that was copied out of one — a shared machine,
	// a stolen backup — is just a string, and without this it would authenticate
	// forever. Expiry has to be checked where the token is honoured; sweeping rows
	// on a timer is housekeeping, and housekeeping is not a security boundary.
	const { rows } = await query(
		`SELECT u.id, u.username, u.created_at, u.admin
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token = $1 AND s.created_at > $2`,
		[token, Date.now() - SESSION_MAX_AGE_MS]
	);
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		username: row.username,
		createdAt: row.created_at,
		admin: isAdminUser({ username: row.username, admin: row.admin })
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

/**
 * Delete session rows past their lifetime.
 *
 * Nothing depends on this having run — getUserFromSession refuses an expired token
 * on its own. This exists because rows outlive the cookies that reference them:
 * the browser stops sending a token after 30 days and never tells the server, so
 * without a sweep the table only ever grows. It arrived from the JSON database
 * holding 80 rows for 71 accounts, most of them for sign-ins nobody would return
 * to.
 *
 * @returns {Promise<number>} rows removed
 */
export async function sweepExpiredSessions() {
	const { rowCount } = await query('DELETE FROM sessions WHERE created_at <= $1', [
		Date.now() - SESSION_MAX_AGE_MS
	]);
	return rowCount;
}

let sweeping = false;
/**
 * Sweep once at boot and then every SWEEP_EVERY_MS. Idempotent.
 *
 * The interval is **unref'd**, which is not a detail. This app already had a bug
 * where background work held the event loop open long past SIGTERM and every
 * container stop ended in a SIGKILL (see installShutdownHandler in db.js); a
 * repeating timer is exactly that shape of mistake. Unref'd, it can never be the
 * reason a process that was ready to leave does not.
 *
 * Failures are logged and swallowed. A sweep that cannot run leaves rows behind,
 * which costs disk and nothing else — it must never be able to stop the app
 * booting or take it down hours later.
 */
export function installSessionSweep() {
	if (sweeping) return;
	sweeping = true;

	const sweep = async () => {
		try {
			const n = await sweepExpiredSessions();
			if (n) console.log(`auth: swept ${n} expired session(s)`);
		} catch (e) {
			console.error('auth: session sweep failed —', e.message);
		}
	};

	// Not awaited: boot should not wait on housekeeping, and the first request does
	// not need it to have finished.
	void sweep();
	setInterval(sweep, SWEEP_EVERY_MS).unref();
}
