import { getCollection, collectionValue } from '$lib/server/game.js';
import { setEntry } from '$lib/server/registry.js';
import { cardMarketGold, cardSellGold } from '$lib/economy.js';

/**
 * The collection screen filters, sorts and selects entirely on the client, so it
 * needs every card — but it does NOT need every field of every card. A stored
 * instance carries its whole print record (colours, mana cost, type line, slot
 * and sheet provenance, four image URLs); the grid and the detail modal between
 * them read a dozen fields. At ten thousand cards the difference is megabytes of
 * SSR payload per page load, so the rows are projected down to what actually
 * renders.
 *
 * Gold values are folded in here too. They are a pure function of `valueUsd`, and
 * computing them once per card server-side keeps them out of the sort comparator,
 * which otherwise recomputed them on every comparison.
 */
const NO_TREATMENTS = Object.freeze([]);

function forDisplay(c, images) {
	return {
		uid: c.uid,
		name: c.name,
		set: c.set,
		setName: c.setName,
		number: c.number,
		rarity: c.rarity,
		foil: !!c.foil,
		finish: c.finish ?? (c.foil ? 'foil' : 'nonfoil'),
		treatments: c.treatments?.length ? c.treatments : NO_TREATMENTS,
		serial: c.serial ?? null,
		serialOf: c.serialOf ?? null,
		acquiredAt: c.acquiredAt || 0,
		scryfallUri: c.scryfallUri || null,
		images,
		marketGold: cardMarketGold(c.valueUsd),
		sellGold: cardSellGold(c.valueUsd)
	};
}

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	const raw = getCollection(locals.user.id);

	// Shared objects, not copies. SvelteKit serialises page data with devalue,
	// which emits a repeated *reference* once — so the sixteen copies of a common
	// in a big collection cost one image record between them instead of sixteen.
	// (Repeated strings devalue already collapses on its own.)
	const imagesByPrint = new Map();
	const cards = raw
		.map((c) => {
			// The grid and the detail modal both render `normal`; `small`, `large`
			// and `art` are on the record but never displayed here.
			const url = c.images?.normal || c.images?.small || null;
			if (url && !imagesByPrint.has(url)) imagesByPrint.set(url, { normal: url });
			return forDisplay(c, url ? imagesByPrint.get(url) : null);
		})
		.sort((a, b) => b.acquiredAt - a.acquiredAt);

	// distinct sets present, for the filter chips
	const setCodes = [...new Set(cards.map((c) => c.set))];
	const sets = setCodes
		.map((code) => ({ code, name: setEntry(code)?.name || String(code).toUpperCase() }))
		.sort((a, b) => a.name.localeCompare(b.name));

	return {
		cards,
		sets,
		value: collectionValue(locals.user.id)
	};
}
