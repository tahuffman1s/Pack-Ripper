import { redirect } from '@sveltejs/kit';
import { getWallet } from '$lib/server/game.js';
import { slotStats, freeSpinState } from '$lib/server/slots.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) throw redirect(303, '/login');

	const [wallet, slots, freeSpins] = await Promise.all([
		getWallet(locals.user.id),
		slotStats(locals.user.id),
		// A bonus round survives a reload — it is server state, not a page flag.
		freeSpinState(locals.user.id)
	]);

	return { wallet, slots, freeSpins };
}
