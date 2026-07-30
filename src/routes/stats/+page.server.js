import {
	getStats,
	getWallet,
	collectionValue,
	collectionCount,
	inventoryCount
} from '$lib/server/game.js';
import { setEntry } from '$lib/server/registry.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	// The collection is counted, not loaded: this page shows a total and a count,
	// and it used to fetch every card to produce both.
	const [stats, wallet, value, cards, packs] = await Promise.all([
		getStats(locals.user.id),
		getWallet(locals.user.id),
		collectionValue(locals.user.id),
		collectionCount(locals.user.id),
		inventoryCount(locals.user.id)
	]);

	// favourite set by packs opened
	const bySet = Object.entries(stats.bySet || {})
		.map(([code, count]) => ({ code, name: setEntry(code)?.name || code.toUpperCase(), count }))
		.sort((a, b) => b.count - a.count);

	return {
		stats,
		wallet,
		collectionValue: value,
		collectionCount: cards,
		inventoryCount: packs,
		bySet
	};
}
