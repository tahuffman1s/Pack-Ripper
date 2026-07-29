import { featuredSets } from '$lib/server/registry.js';
import {
	getWallet,
	getStats,
	getInventory,
	getOpenings,
	collectionValue,
	fromPriceGold
} from '$lib/server/game.js';

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	const featured = featuredSets()
		.map((s) => ({
			code: s.code,
			name: s.name,
			year: s.year,
			tag: s.tag,
			icon: s.icon,
			fromPrice: fromPriceGold(s)
		}))
		.sort((a, b) => (b.year || 0) - (a.year || 0));

	return {
		featured,
		wallet: getWallet(locals.user.id),
		stats: getStats(locals.user.id),
		inventoryCount: getInventory(locals.user.id).length,
		recent: getOpenings(locals.user.id).slice(0, 5),
		collectionValue: collectionValue(locals.user.id)
	};
}
