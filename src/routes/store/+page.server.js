import { storeSets } from '$lib/server/registry.js';
import { PACK_TYPES } from '$lib/packs.js';
import { fromPriceGold, packPriceUsd, priceIsLive } from '$lib/server/game.js';

/** @type {import('./$types').PageServerLoad} */
export function load() {
	const sets = storeSets().map((s) => ({
		code: s.code,
		name: s.name,
		year: s.year,
		type: s.type,
		icon: s.icon,
		tag: s.tag,
		featured: s.featured,
		unreleased: s.unreleased,
		released: s.released,
		packLabels: s.packTypes.map((t) => PACK_TYPES[t]?.short || t),
		fromPrice: fromPriceGold(s),
		fromUsd: Number(Math.min(...s.packTypes.map((t) => packPriceUsd(s, t))).toFixed(2)),
		live: s.packTypes.some((t) => priceIsLive(s, t, 'pack'))
	}));

	return { sets, count: sets.length };
}
