import { redirect } from '@sveltejs/kit';
import { getWallet, inventoryCount, collectionValue } from '$lib/server/game.js';
import { netWorthGold, STUCK_BELOW } from '$lib/server/rescue.js';

const PUBLIC = new Set(['/login', '/register']);

/** @type {import('./$types').LayoutServerLoad} */
export async function load({ locals, url }) {
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

	// This is the hottest load in the app — it runs on every navigation — so the
	// four figures are fetched concurrently rather than as a waterfall. All four
	// are aggregates: none of them loads a card row or a pack row, which the two
	// counts and the collection total all used to do.
	//
	// "Stuck" means no gold to spend, no packs to open and nothing worth
	// selling — a dead end. The Bulk Bin banner appears wherever they are.
	const [wallet, packs, value, worth] = await Promise.all([
		getWallet(user.id),
		inventoryCount(user.id),
		collectionValue(user.id),
		netWorthGold(user.id)
	]);

	return {
		user,
		wallet,
		inventoryCount: packs,
		collectionValue: value,
		stuck: worth.total < STUCK_BELOW,
		netWorth: worth.total
	};
}
