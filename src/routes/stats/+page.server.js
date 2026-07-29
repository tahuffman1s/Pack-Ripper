import { getStats, getWallet, collectionValue, getCollection, getInventory } from '$lib/server/game.js';
import { setEntry } from '$lib/server/registry.js';

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	const stats = getStats(locals.user.id);
	const collection = getCollection(locals.user.id);

	// favourite set by packs opened
	const bySet = Object.entries(stats.bySet || {})
		.map(([code, count]) => ({ code, name: setEntry(code)?.name || code.toUpperCase(), count }))
		.sort((a, b) => b.count - a.count);

	return {
		stats,
		wallet: getWallet(locals.user.id),
		collectionValue: collectionValue(locals.user.id),
		collectionCount: collection.length,
		inventoryCount: getInventory(locals.user.id).length,
		bySet
	};
}
