import { redirect } from '@sveltejs/kit';
import { getWallet } from '$lib/server/game.js';
import { slotStats, freeSpinState } from '$lib/server/slots.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) throw redirect(303, '/login');
	return {
		wallet: getWallet(locals.user.id),
		slots: slotStats(locals.user.id),
		// A bonus round survives a reload — it is server state, not a page flag.
		freeSpins: freeSpinState(locals.user.id)
	};
}
