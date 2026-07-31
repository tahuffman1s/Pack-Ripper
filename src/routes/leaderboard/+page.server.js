import { redirect } from '@sveltejs/kit';
import { leaderboards } from '$lib/server/leaderboard.js';
import { recentAnnouncements } from '$lib/server/announce.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) throw redirect(303, '/login');

	const [board, news] = await Promise.all([
		leaderboards(locals.user.id),
		// The noticeboard's full history lives here rather than only flashing past in
		// the layout's toasts — this is the page you come to in order to look.
		recentAnnouncements(30)
	]);

	return { ...board, news };
}
