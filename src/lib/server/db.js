import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	copyFileSync,
	statSync
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Tiny file-backed JSON "database".
 *
 * Chosen over better-sqlite3 so the app has ZERO native build dependencies and
 * runs anywhere Node runs. Everything is kept in memory and flushed to disk
 * atomically (write temp + rename) on every mutation. Fine for a single-process
 * simulator; not meant for high concurrency.
 *
 * The rest of this file is mostly about not destroying that one file. It holds
 * every account, so the worst thing it can do is not "lose a write" — it is
 * "write an empty database over a full one", and there were three ways to get
 * there. Each is now blocked, and none of them relied on noticing in time:
 *
 *  1. A missing db.json used to be created immediately, empty. On Azure .data is
 *     an SMB mount, and a mount that is not attached yet looks exactly like a
 *     first-ever boot — so the app wrote an empty database onto the share and the
 *     real one was gone. Nothing is written now until a real mutation happens.
 *  2. An unreadable db.json used to be replaced by an empty one, which also
 *     destroyed the evidence. It is now moved aside, kept, and recovered from.
 *  3. The SMB fallback below writes in place, non-atomically. A container killed
 *     mid-write — which is what a new revision does to the old one — left a torn
 *     file, and the next boot hit path 2. There is now a complete second copy to
 *     fall back on, and the torn file is never mistaken for the truth.
 */

const DATA_DIR = join(process.cwd(), '.data');
const DB_PATH = join(DATA_DIR, 'db.json');
const BAK_PATH = DB_PATH + '.bak';
const TMP_PATH = DB_PATH + '.tmp';

/** Escape hatch: set to deliberately start over on a share that has data. */
const ALLOW_RESET = process.env.ALLOW_DB_RESET === '1';

/** How often to refresh the backup copy. Every flush would double SMB writes. */
const BACKUP_EVERY_MS = 1000 * 60 * 5;

/**
 * How long a shutdown may take before this process stops being polite about it.
 * Under a container's ten-second stop grace, so the exit is ours rather than a
 * SIGKILL; see installShutdownFlush.
 *
 * Anything unparseable falls back rather than becoming NaN, which setTimeout
 * would treat as "now" — turning a typo into a shutdown that abandons in-flight
 * requests.
 */
const SHUTDOWN_GRACE_MS =
	Number(process.env.SHUTDOWN_GRACE_MS) > 0 ? Number(process.env.SHUTDOWN_GRACE_MS) : 8000;

const DEFAULT_DB = {
	users: {}, // id -> { id, username, passwordHash, salt, createdAt, admin? }
	usernames: {}, // lowercased username -> userId
	sessions: {}, // token -> { userId, createdAt }
	wallets: {}, // userId -> { gold }
	inventory: {}, // userId -> [ { id, setCode, packTypeId, acquiredAt } ]  (unopened packs)
	collections: {}, // userId -> [ cardInstance ]
	stats: {}, // userId -> stats object
	openings: {}, // userId -> [ recent opening summaries ]
	serials: {}, // scryfallId -> [ issued serial numbers ]  (a 1/1 exists once, globally)
	freeSpins: {}, // userId -> { remaining, lineBet, lines }  (slot bonus round)
	blackjack: {}, // userId -> { shoe, phase, dealer, hands, active }  (table in play)
	adminLog: [] // newest-first audit trail of admin actions (capped)
};

let db = null;
let flushTimer = null;
let lastBackupAt = 0;

/** What happened at load, for the startup log and the admin panel. */
let status = { loadedFrom: null, users: 0, startedEmpty: false, recovered: null, refusals: 0 };

const userCount = (o) => Object.keys(o?.users || {}).length;

/** Parse one candidate file. Returns null if it is absent or not usable. */
function readSnapshot(path) {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8'));
		// A JSON file that parses but has no users map is not a database — most
		// likely a half-written one that happened to land on valid syntax.
		if (!parsed || typeof parsed !== 'object' || !parsed.users) return null;
		return parsed;
	} catch (e) {
		console.error(`db: ${path} is unreadable — ${e.message}`);
		return null;
	}
}

/** Keep a bad file instead of overwriting it. Nothing here is worth losing twice. */
function setAside(path) {
	if (!existsSync(path)) return null;
	const kept = `${path}.corrupt-${Date.now()}`;
	try {
		renameSync(path, kept);
		return kept;
	} catch {
		try {
			copyFileSync(path, kept);
			return kept;
		} catch {
			return null;
		}
	}
}

function ensureLoaded() {
	if (db) return db;
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

	// In preference order. db.json.tmp is a real candidate, not debris: it is
	// written in full before the rename, so if the rename never happened it is the
	// newest complete copy that exists.
	const primary = readSnapshot(DB_PATH);
	if (primary) {
		db = { ...structuredClone(DEFAULT_DB), ...primary };
		status = { ...status, loadedFrom: DB_PATH, users: userCount(db), startedEmpty: false };
	} else {
		const kept = existsSync(DB_PATH) ? setAside(DB_PATH) : null;
		const fallback =
			[
				[BAK_PATH, readSnapshot(BAK_PATH)],
				[TMP_PATH, readSnapshot(TMP_PATH)]
			].find(([, v]) => v) || null;

		if (fallback) {
			db = { ...structuredClone(DEFAULT_DB), ...fallback[1] };
			status = {
				...status,
				loadedFrom: fallback[0],
				users: userCount(db),
				startedEmpty: false,
				recovered: kept
			};
			console.error(
				`db: RECOVERED ${status.users} account(s) from ${fallback[0]}.` +
					(kept ? ` The unusable file was kept at ${kept}.` : '')
			);
		} else {
			// Nothing readable anywhere. Start empty IN MEMORY ONLY — see note 1 at
			// the top. A not-yet-attached mount is indistinguishable from a first
			// boot, and only one of those two should ever write.
			db = structuredClone(DEFAULT_DB);
			status = { ...status, loadedFrom: null, users: 0, startedEmpty: true, recovered: kept };
			console.error(
				`db: no usable database at ${DB_PATH} — starting empty. ` +
					'Nothing will be written until something actually changes. If this is a ' +
					'restart rather than a first run, the volume is probably not mounted.'
			);
		}
	}

	if (status.loadedFrom) {
		console.log(`db: loaded ${status.users} account(s) from ${status.loadedFrom}`);
	}
	return db;
}

/**
 * Refuse to overwrite accounts this process has never seen.
 *
 * Only a process that failed to load a database can be about to do this; once we
 * have read one, our copy is the authority and this never fires. The test is
 * per-account rather than "is memory empty", because the sequence that actually
 * loses data is: boot with the volume unattached, the share appears, someone
 * registers — and by then memory holds one account, which an emptiness check
 * reads as a legitimate database worth saving. It is not. It is missing 71 others.
 *
 * Set ALLOW_DB_RESET=1 to start over deliberately.
 */
let diskSig = null;
let diskVerdict = false;

function wouldDestroyData() {
	if (ALLOW_RESET) return false;
	if (!status.startedEmpty) return false;

	// One stat per flush instead of a read-and-parse, since this runs for the life
	// of a process that started empty and the answer only changes when the file does.
	let sig = 'none';
	try {
		const s = statSync(DB_PATH);
		sig = `${s.size}:${s.mtimeMs}`;
	} catch {
		sig = 'none';
	}
	if (sig === diskSig) return diskVerdict;
	diskSig = sig;

	const onDisk = readSnapshot(DB_PATH) || readSnapshot(BAK_PATH);
	if (!onDisk) {
		diskVerdict = false;
		return false;
	}
	const mine = new Set(Object.keys(db.users || {}));
	diskVerdict = Object.keys(onDisk.users || {}).some((id) => !mine.has(id));
	return diskVerdict;
}

/** Second complete copy, refreshed on a timer rather than on every write. */
function refreshBackup(now) {
	if (now - lastBackupAt < BACKUP_EVERY_MS) return;
	if (!existsSync(DB_PATH)) return;
	try {
		// Only from a file that currently parses — a backup of a torn file is worse
		// than no backup, because it is the thing recovery trusts.
		if (!readSnapshot(DB_PATH)) return;
		copyFileSync(DB_PATH, BAK_PATH);
		lastBackupAt = now;
	} catch (e) {
		console.error('db: backup copy failed:', e.message);
	}
}

function flushNow() {
	if (!db) return;
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

	if (wouldDestroyData()) {
		status.refusals++;
		console.error(
			'db: REFUSING to save — the file on disk holds accounts this process never ' +
				'loaded, so writing would erase them. The volume was almost certainly not ' +
				'mounted at startup. Restart with it attached (anything created since this ' +
				'process started will be lost, which is the smaller loss). Set ALLOW_DB_RESET=1 ' +
				'only if you mean to erase what is there.'
		);
		return;
	}

	const now = Date.now();
	refreshBackup(now);

	const json = JSON.stringify(db, null, '\t');
	writeFileSync(TMP_PATH, json);
	try {
		renameSync(TMP_PATH, DB_PATH);
		return;
	} catch (e) {
		console.error('db: atomic rename failed:', e.message);
	}

	// Azure Files (SMB) can refuse a rename ONTO an existing file while allowing a
	// rename to a free name. Clearing the target first keeps the write atomic,
	// which the in-place path below does not.
	try {
		unlinkSync(DB_PATH);
		renameSync(TMP_PATH, DB_PATH);
		return;
	} catch (e) {
		console.error('db: unlink-then-rename failed:', e.message);
	}

	// Last resort. Truncates and rewrites in place, so a process killed here leaves
	// a torn file — which is why db.json.tmp is deliberately left behind as a
	// complete copy for the next boot to recover from.
	try {
		writeFileSync(DB_PATH, json);
	} catch (e) {
		console.error('db: in-place write failed, database NOT saved:', e.message);
	}
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

/**
 * Flush right now, skipping the debounce. Called when the process is going away:
 * a new Azure revision stops the old container, and a pending 60ms timer does not
 * survive that.
 */
export function flushSync() {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	try {
		flushNow();
	} catch (e) {
		console.error('DB final flush failed:', e);
	}
}

let hooked = false;
/**
 * Persist on shutdown, and make sure the shutdown actually finishes. Idempotent,
 * so importing this twice is harmless.
 *
 * Flushing on the signal is the easy half. The half that was broken is that the
 * process did not exit at all. adapter-node's own SIGTERM handler closes the HTTP
 * server and then simply expects the event loop to empty — and this app's does
 * not. Startup fires warmSealed() and warmVintageEv() into the background, and on
 * a cold cache those spend minutes on outbound fetches and throttle timers, every
 * one of which holds the process open. Measured: still running 122 seconds after
 * SIGTERM. So every container stop ended in a SIGKILL, and the only reason the
 * database survived that is that the flush below is synchronous.
 *
 * Hence the two exits. `sveltekit:shutdown` is emitted by adapter-node from its
 * httpServer.close() callback, which is precisely the moment when waiting longer
 * buys nothing: in-flight requests have finished, and what is left is background
 * work whose only product is regenerable cache. The timer is the backstop for
 * that event never arriving — unref'd, so it can never hold up a process that was
 * ready to leave on its own, which is exactly what an unref'd timer is for.
 *
 * Neither exit path flushes on its own, because process.exit() runs the `exit`
 * listener below and that is one 4 MB write, not two. `exit` rather than
 * `beforeExit` is what catches an explicit exit; both are registered because
 * `beforeExit` is the one that catches a loop that empties by itself.
 */
export function installShutdownFlush() {
	if (hooked) return;
	hooked = true;

	const leave = (why) => {
		console.log(`db: ${why} — exiting`);
		process.exit(0);
	};

	for (const sig of ['SIGTERM', 'SIGINT']) {
		process.on(sig, () => {
			console.log(`db: ${sig} — flushing`);
			flushSync();
			setTimeout(() => leave('shutdown took too long'), SHUTDOWN_GRACE_MS).unref();
		});
	}
	process.on('sveltekit:shutdown', () => leave('server drained'));

	process.on('exit', flushSync);
	process.on('beforeExit', flushSync);
}

/** Where the data came from and whether anything looked wrong. For /admin. */
export function dbStatus() {
	ensureLoaded();
	let bytes = null;
	try {
		bytes = statSync(DB_PATH).size;
	} catch {
		bytes = null;
	}
	return {
		path: DB_PATH,
		loadedFrom: status.loadedFrom,
		startedEmpty: status.startedEmpty,
		recoveredFrom: status.recovered,
		refusedWrites: status.refusals,
		usersAtLoad: status.users,
		bytes,
		hasBackup: existsSync(BAK_PATH),
		allowReset: ALLOW_RESET
	};
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
