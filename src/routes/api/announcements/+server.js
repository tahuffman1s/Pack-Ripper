import { json, error } from '@sveltejs/kit';
import { recentAnnouncements } from '$lib/server/announce.js';

/**
 * The noticeboard, polled by the layout.
 *
 * `since` is a millisecond timestamp and the client sends back the newest `at` it
 * has already shown, so a poll normally returns an empty list and costs one
 * indexed lookup. There is no cursor state on the server — the client owns its own
 * high-water mark, which means a reload or a second tab simply re-reads the tail
 * rather than missing anything.
 */

/** @type {import('./$types').RequestHandler} */
export async function GET({ url, locals }) {
	// Signed in only. The board is not secret, but it names players, and every
	// other read in this app requires an account.
	if (!locals.user) throw error(401, 'Not signed in');

	const since = Number(url.searchParams.get('since')) || 0;
	const items = await recentAnnouncements(20, since);

	return json(
		{ items, now: Date.now() },
		// Never cached: the whole point is that it is current, and a proxy holding
		// this for even a few seconds would make announcements arrive in batches.
		{ headers: { 'cache-control': 'no-store' } }
	);
}
