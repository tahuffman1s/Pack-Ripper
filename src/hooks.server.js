import { SESSION_COOKIE, getUserFromSession, installSessionSweep } from '$lib/server/auth.js';
import { ensureSets } from '$lib/server/registry.js';
import { initDb, installShutdownHandler } from '$lib/server/db.js';
import { importLegacyJson } from '$lib/server/importJson.js';

// Connect, apply the schema and report what is there before serving anything.
//
// Top-level await, deliberately: the module does not finish evaluating until the
// database is ready, and SvelteKit does not serve a request until this module has
// finished evaluating. A request that arrived against a database with no schema
// would fail in a way that reads like a code bug rather than a startup ordering
// one. initDb() throws if it cannot connect after its retries, which takes the
// process down and lets the container's restart policy try again — there is no
// useful degraded mode for an app whose every page needs the database.
await initDb();

// Carry a legacy .data/db.json across on first boot. Does nothing at all unless
// the database has no accounts AND such a file exists, so it stays harmless once
// the migration has happened — see importJson.js for why that guard is enough.
// Set IMPORT_LEGACY_JSON=0 to skip it outright.
if (process.env.IMPORT_LEGACY_JSON !== '0') {
	try {
		await importLegacyJson();
	} catch (e) {
		// A failed import rolled back, so the database is still empty and the old
		// file is still on disk. Serving an empty app is recoverable; refusing to
		// boot over it is not more useful.
		console.error('import: failed, continuing with an empty database —', e.message);
	}
}

// Expired session rows outlive the cookies that point at them — a browser stops
// sending a 30-day-old token and never says so — so they are swept on a timer.
// Not awaited, and the timer is unref'd; see installSessionSweep.
installSessionSweep();

installShutdownHandler();

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
	// Populate the set registry once (from the disk-cached Scryfall /sets list).
	try {
		await ensureSets();
	} catch (e) {
		console.error('Failed to load sets from Scryfall:', e);
	}
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.user = (await getUserFromSession(token)) ?? null;
	return resolve(event);
}
