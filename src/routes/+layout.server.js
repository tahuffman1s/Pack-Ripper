import { redirect } from '@sveltejs/kit';
import { getWallet, getInventory, collectionValue } from '$lib/server/game.js';
import { netWorthGold, STUCK_BELOW } from '$lib/server/rescue.js';

const PUBLIC = new Set(['/login', '/register']);

/** @type {import('./$types').LayoutServerLoad} */
export function load({ locals, url }) {
	const user = locals.user;

	if (!user && !PUBLIC.has(url.pathname)) {
		throw redirect(303, '/login');
	}
	if (user && PUBLIC.has(url.pathname)) {
		throw redirect(303, '/');
	}

	if (!user) {
		return { user: null, wallet: null, inventoryCount: 0, collectionValue: 0, stuck: false };
	}

	// "Stuck" means no gold to spend, no packs to open and nothing worth
	// selling — a dead end. The Bulk Bin banner appears wherever they are.
	const worth = netWorthGold(user.id);

	return {
		user,
		wallet: getWallet(user.id),
		inventoryCount: getInventory(user.id).length,
		collectionValue: collectionValue(user.id),
		stuck: worth.total < STUCK_BELOW,
		netWorth: worth.total
	};
}
