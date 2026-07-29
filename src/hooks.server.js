import { SESSION_COOKIE, getUserFromSession } from '$lib/server/auth.js';
import { ensureSets } from '$lib/server/registry.js';

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
