import { SESSION_COOKIE, getUserFromSession } from '$lib/server/auth.js';
import { ensureSets } from '$lib/server/registry.js';
import { getDb, installShutdownFlush } from '$lib/server/db.js';

// Load the database and report what happened before serving anything, so the log
// says which file the accounts came from — that is the only way to tell a mounted
// volume from an unmounted one without guessing. Also flush on SIGTERM: a new
// Azure revision stops the old container, and a debounced write does not outlive it.
getDb();
installShutdownFlush();

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
	// Populate the set registry once (from the disk-cached Scryfall /sets list).
	try {
		await ensureSets();
	} catch (e) {
		console.error('Failed to load sets from Scryfall:', e);
	}
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.user = getUserFromSession(token) ?? null;
	return resolve(event);
}
