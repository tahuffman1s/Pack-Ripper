import { redirect } from '@sveltejs/kit';
import { getWallet } from '$lib/server/game.js';
import { tableState, blackjackStats } from '$lib/server/blackjack.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) throw redirect(303, '/login');

	const [wallet, table, stats] = await Promise.all([
		getWallet(locals.user.id),
		// A hand in progress is server state, so it survives a reload. tableState
		// reads the balance too, because which moves are legal depends on it.
		tableState(locals.user.id),
		blackjackStats(locals.user.id)
	]);

	return { wallet, table, stats };
}
