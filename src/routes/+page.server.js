import { featuredSets } from '$lib/server/registry.js';
import {
	getWallet,
	getStats,
	inventoryCount,
	getOpenings,
	collectionValue,
	fromPriceGold
} from '$lib/server/game.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
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

	const [wallet, stats, packs, recent, value] = await Promise.all([
		getWallet(locals.user.id),
		getStats(locals.user.id),
		inventoryCount(locals.user.id),
		getOpenings(locals.user.id),
		collectionValue(locals.user.id)
	]);

	return {
		featured,
		wallet,
		stats,
		inventoryCount: packs,
		recent: recent.slice(0, 5),
		collectionValue: value
	};
}
