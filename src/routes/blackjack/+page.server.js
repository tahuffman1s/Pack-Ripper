import { redirect } from '@sveltejs/kit';
import { getWallet } from '$lib/server/game.js';
import { publicView, blackjackStats } from '$lib/server/blackjack.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) throw redirect(303, '/login');
	return {
		wallet: getWallet(locals.user.id),
		// A hand in progress is server state, so it survives a reload.
		table: publicView(locals.user.id),
		stats: blackjackStats(locals.user.id)
	};
}
