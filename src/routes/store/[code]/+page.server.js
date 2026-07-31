import { error, fail } from '@sveltejs/kit';
import { setEntry } from '$lib/server/registry.js';
import { productsForSet, buy, MAX_BUY_PACKS } from '$lib/server/game.js';
import { fetchSetSealed } from '$lib/server/tcgplayer.js';
import { getCollation } from '$lib/server/collation.js';
import { packEvUsd } from '$lib/server/packvalue.js';
import { loadSales } from '$lib/server/sales.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ params }) {
	const set = setEntry(params.code);
	if (!set) throw error(404, 'Set not found');

	// Live TCGplayer sealed prices, and the MTGJSON collation slice — the latter
	// tells us the real packs-per-box for this set (they vary: 2XM boxes are 24)
	// and which booster products it actually shipped with.
	await Promise.allSettled([fetchSetSealed(set.code, set.name), getCollation(set.code)]);
	// Price floor from the real sheets — see packvalue.js. Warmed here so the
	// store shows a sane price for vintage product on first view.
	await Promise.allSettled((set.packTypes || []).map((t) => packEvUsd(set.code, t)));
	// Sale rules, so productsForSet() can quote the price the store is charging
	// today rather than the market price.
	await loadSales();

	return {
		set: {
			code: set.code,
			name: set.name,
			year: set.year,
			type: set.type,
			tag: set.tag,
			released: set.released,
			cardCount: set.cardCount,
			featured: set.featured,
			unreleased: set.unreleased
		},
		icon: set.icon || null,
		products: productsForSet(set),
		maxBuyPacks: MAX_BUY_PACKS
	};
}

/** @type {import('./$types').Actions} */
export const actions = {
	buy: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not signed in.' });
		const form = await request.formData();
		const setCode = String(form.get('setCode') || '');
		const packTypeId = String(form.get('packTypeId') || '');
		const kind = String(form.get('kind') || 'pack');
		const qty = Number(form.get('qty') || 1);

		// Awaits: buy() computes the vintage price floor first if it is not already
		// known, so what it charges cannot depend on cache warmth.
		const result = await buy(locals.user.id, { setCode, packTypeId, kind, qty });
		if (!result.ok) return fail(400, { error: result.error });
		return {
			success: true,
			added: result.added,
			units: result.units,
			price: result.price,
			gold: result.gold,
			kind,
			packTypeId
		};
	}
};
