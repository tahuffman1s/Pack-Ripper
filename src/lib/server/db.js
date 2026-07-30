import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { SCHEMA_SQL } from './schema.js';

/**
 * Postgres, via a connection pool.
 *
 * This replaced a file-backed JSON database, and the reason was not scale — 71
 * accounts is nothing. It was that the old design rewrote the ENTIRE database on
 * every mutation: every slot spin, every blackjack hit, every card sold flushed
 * megabytes. That cost grew with the size of the whole server rather than with
 * the size of the change, it wore out SD cards on the Pi, and about two thirds of
 * the old db.js was machinery defending a single 4 MB file against torn writes,
 * unmounted volumes and SMB rename semantics. None of that code exists any more,
 * because none of those failures are the application's to survive.
 *
 * What replaced it needs one thing said clearly, because it is the one real
 * hazard the change introduced:
 *
 *   The old data layer was SYNCHRONOUS, and that made every read-then-write
 *   atomic for free. `if (wallet.gold < cost) return; ... wallet.gold -= cost`
 *   could not interleave with another request, because Node runs one thing at a
 *   time and there was no await between the test and the write. Every one of
 *   those sequences now has an await in the middle, so two requests from the same
 *   player CAN interleave, and a balance check that passes twice would let the
 *   same gold be spent twice.
 *
 * So every path that moves money takes a row lock on the wallet FIRST, inside the
 * transaction, and does its arithmetic after. That is what lockGold() is for, and
 * it is not optional on those paths — it is what restores the guarantee the
 * synchronous version had by accident.
 */

/**
 * int8 comes back from pg as a STRING by default, because a 64-bit integer does
 * not always fit a JS number. Everything stored as bigint here is either an epoch
 * millisecond timestamp or a gold balance capped at 1e12 by admin.js — both far
 * below 2^53, so the conversion is exact and every consumer gets the number it
 * already expects. Without this, gold arrives as "500" and `gold - cost` is NaN.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

/**
 * Where the database is. DATABASE_URL is the whole configuration; with it unset,
 * node-postgres falls back to the standard PGHOST/PGUSER/PGDATABASE variables,
 * which is what makes `psql`-style environments work unchanged.
 */
const CONNECTION_STRING = process.env.DATABASE_URL || undefined;

/**
 * Azure and other managed providers require TLS and present a certificate this
 * app has no CA bundle for; `sslmode=require` in the URL is honoured by pg but
 * still verifies. PGSSLMODE=no-verify is the documented escape hatch for that,
 * and is only reachable by explicitly setting it.
 */
const ssl =
	process.env.PGSSLMODE === 'no-verify' ? { rejectUnauthorized: false } : undefined;

const pool = new pg.Pool({
	connectionString: CONNECTION_STRING,
	ssl,
	// A Pi does not want thirty backends, and this app is one process serving one
	// small player base. Ten is plenty and leaves headroom under Postgres's
	// default max_connections of 100 for psql and pg_dump.
	max: Number(process.env.PGPOOL_MAX) > 0 ? Number(process.env.PGPOOL_MAX) : 10,
	idleTimeoutMillis: 30_000,
	// Fail a request rather than hanging it forever if the pool is exhausted by a
	// leak. A hung request looks like the app is broken; an error says which.
	connectionTimeoutMillis: 10_000
});

/**
 * An idle client whose backend dies (Postgres restarted, network dropped) emits
 * 'error' on the POOL, and an unhandled 'error' event on an EventEmitter takes
 * the process down. Logging it lets the pool discard that client and hand the
 * next request a fresh one, which is the behaviour that survives a `docker
 * compose restart db`.
 */
pool.on('error', (e) => {
	console.error('db: idle client error —', e.message);
});

/** What happened at startup, for the boot log and the admin panel. */
let status = { ready: false, error: null, usersAtBoot: 0, serverVersion: null, imported: null };

/**
 * Run one statement outside a transaction. For single reads and single writes;
 * anything that reads a value and then writes based on it belongs in tx().
 */
export async function query(text, params) {
	return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction, passing it the dedicated client. Commits on
 * return, rolls back on throw, and always gives the connection back.
 *
 * The client MUST be used for every statement inside — reaching for the exported
 * query() in here would run that statement on a different connection, outside the
 * transaction, and it would neither see the uncommitted work nor be rolled back
 * with it.
 */
export async function tx(fn) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (e) {
		try {
			await client.query('ROLLBACK');
		} catch (rollbackError) {
			// The connection is already unusable; the original error is the useful one.
			console.error('db: rollback failed —', rollbackError.message);
		}
		throw e;
	} finally {
		client.release();
	}
}

/**
 * Read a wallet balance and hold the row until the transaction ends.
 *
 * This is the lock described at the top of the file, and every path that spends
 * or pays out gold must call it before deciding whether the player can afford
 * something. Two concurrent spins now queue behind each other instead of both
 * reading the same balance.
 *
 * Returns null when there is no wallet row, which callers report as an error
 * rather than treating as a zero balance.
 */
export async function lockGold(client, userId) {
	const { rows } = await client.query(
		'SELECT gold FROM wallets WHERE user_id = $1 FOR UPDATE',
		[userId]
	);
	return rows.length ? rows[0].gold : null;
}

/** Set a wallet to an exact value. Only ever called with a locked, computed balance. */
export async function setGold(client, userId, gold) {
	await client.query('UPDATE wallets SET gold = $2 WHERE user_id = $1', [userId, gold]);
}

/**
 * Read a player's stats blob and hold the row until the transaction ends.
 *
 * Stats stay one jsonb document, and the update stays a whole-object
 * read-modify-write, because that is what the counters need: `bestPull` is a
 * comparison against the current best, `bySet` is a map keyed by set code, and
 * every game mode adds fields. Expressing those as in-place jsonb arithmetic
 * would be a different piece of SQL per counter for no benefit, so the lock is
 * what makes the read-modify-write safe instead.
 *
 * The no-op `DO UPDATE SET data = stats.data` is the point of the upsert: it
 * creates the row if it is missing, takes the row lock either way, and returns
 * the current value, in one round trip. A plain SELECT ... FOR UPDATE cannot lock
 * a row that does not exist yet.
 */
export async function lockStats(client, userId) {
	const { rows } = await client.query(
		`INSERT INTO stats (user_id, data) VALUES ($1, '{}'::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET data = stats.data
		 RETURNING data`,
		[userId]
	);
	return rows[0].data || {};
}

/** Write a stats blob back. Pairs with lockStats inside one transaction. */
export async function writeStats(client, userId, data) {
	await client.query('UPDATE stats SET data = $2::jsonb WHERE user_id = $1', [
		userId,
		JSON.stringify(data)
	]);
}

/** Read a stats blob without locking, for display. Returns {} when there is no row. */
export async function readStats(userId) {
	const { rows } = await pool.query('SELECT data FROM stats WHERE user_id = $1', [userId]);
	return rows[0]?.data || {};
}

/**
 * Bring the database up: connect, apply the schema, report what is there.
 *
 * Called with top-level await from hooks.server.js so it is guaranteed to have
 * finished before the first request is served — a request that arrived against a
 * schema-less database would fail in a way that looks like a code bug.
 *
 * The retry loop is for compose ordering. `depends_on: service_healthy` covers it
 * in the files here, but a Pi restarting both containers at boot is slow enough
 * that being tolerant is cheaper than being right about the ordering everywhere.
 */
export async function initDb({ retries = 30, delayMs = 1000 } = {}) {
	let lastError = null;

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const { rows } = await pool.query('SELECT version() AS v, current_database() AS db');
			status.serverVersion = rows[0].v.split(' ').slice(0, 2).join(' ');

			// The entire migration story. Every statement is IF NOT EXISTS, so this is
			// a no-op against a database that already has the schema, and it means a
			// fresh volume needs no separate setup step.
			await pool.query(SCHEMA_SQL);

			const { rows: counted } = await pool.query('SELECT count(*)::int AS n FROM users');
			status.usersAtBoot = counted[0].n;
			status.ready = true;
			status.error = null;

			console.log(
				`db: ${status.serverVersion} on "${rows[0].db}" — ${status.usersAtBoot} account(s)`
			);
			return status;
		} catch (e) {
			lastError = e;
			status.error = e.message;
			if (attempt < retries) {
				console.error(
					`db: not ready (${e.message}) — retrying in ${delayMs}ms [${attempt}/${retries}]`
				);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
	}

	// Nothing this app does works without the database, so there is no degraded
	// mode worth booting into. Exiting lets the container's restart policy retry
	// with a clean process instead of serving errors that look like bugs.
	console.error(
		`db: could not reach Postgres after ${retries} attempts — ${lastError?.message}. ` +
			'Check DATABASE_URL and that the db service is up.'
	);
	throw lastError;
}

/** Where the data lives and whether anything looked wrong. For /admin. */
export async function dbStatus() {
	const out = {
		kind: 'postgres',
		ready: status.ready,
		error: status.error,
		serverVersion: status.serverVersion,
		usersAtBoot: status.usersAtBoot,
		imported: status.imported,
		pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
		database: null,
		host: null,
		bytes: null
	};

	try {
		const { rows } = await pool.query(
			`SELECT current_database() AS db,
			        inet_server_addr()::text AS host,
			        pg_database_size(current_database()) AS bytes`
		);
		out.database = rows[0].db;
		// Null over a unix socket, which is not an error — just not an address.
		out.host = rows[0].host || 'local';
		out.bytes = Number(rows[0].bytes);
	} catch (e) {
		out.error = out.error || e.message;
	}

	return out;
}

/** Record what an import did, so the admin panel can show it. */
export function noteImport(summary) {
	status.imported = summary;
}

let hooked = false;
/**
 * Make sure the process actually exits, and close the pool on the way out.
 *
 * The exiting half of this predates Postgres and is unrelated to it. adapter-node
 * closes the HTTP server on SIGTERM and then expects the event loop to empty —
 * and this app's does not. Startup fires warmSealed() and warmVintageEv() into
 * the background, and on a cold cache those spend minutes on outbound fetches and
 * throttle timers, every one of which holds the process open. Measured: still
 * running 122 seconds after SIGTERM. So every container stop ended in a SIGKILL.
 *
 * That mattered enormously when a SIGKILL could interrupt a 4 MB write to the one
 * file holding every account. It matters much less now — a committed transaction
 * is committed, and Postgres is a different process that was not signalled — but
 * a container that takes two minutes to stop is still a container that takes two
 * minutes to deploy, so the two exits stay.
 *
 * `sveltekit:shutdown` is emitted by adapter-node from its httpServer.close()
 * callback, which is the moment when waiting longer buys nothing: in-flight
 * requests have finished and what remains is background work whose only product
 * is regenerable cache. The timer is the backstop for that event never arriving —
 * unref'd, so it can never hold up a process that was ready to leave on its own.
 */
export function installShutdownHandler() {
	if (hooked) return;
	hooked = true;

	const grace = Number(process.env.SHUTDOWN_GRACE_MS) > 0 ? Number(process.env.SHUTDOWN_GRACE_MS) : 8000;

	let leaving = false;
	const leave = async (why) => {
		if (leaving) return;
		leaving = true;
		console.log(`db: ${why} — closing pool and exiting`);
		// Give in-flight transactions a moment to commit, but never block the exit
		// on them: end() waits for every client to be released, and a leaked client
		// would hang the shutdown forever.
		await Promise.race([pool.end().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
		process.exit(0);
	};

	for (const sig of ['SIGTERM', 'SIGINT']) {
		process.on(sig, () => {
			console.log(`db: ${sig} — draining`);
			setTimeout(() => leave('shutdown took too long'), grace).unref();
		});
	}
	process.on('sveltekit:shutdown', () => leave('server drained'));
}

export function makeId() {
	// 12 bytes of CSPRNG rather than Date.now() plus two Math.random() slices. Card
	// uids and inventory ids are primary keys now, so a collision is a constraint
	// violation in someone's face rather than a silently overwritten object, and
	// session tokens were the only thing here that was ever unguessable.
	return randomBytes(12).toString('base64url');
}
