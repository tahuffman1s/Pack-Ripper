import { getCollection, collectionValue } from '$lib/server/game.js';
import { setEntry } from '$lib/server/registry.js';

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	const cards = [...getCollection(locals.user.id)];
	// newest first by default; the client can re-sort
	cards.sort((a, b) => (b.acquiredAt || 0) - (a.acquiredAt || 0));

	// distinct sets present, for the filter chips
	const setCodes = [...new Set(cards.map((c) => c.set))];
	const sets = setCodes.map((code) => ({
		code,
		name: setEntry(code)?.name || code.toUpperCase()
	}));

	return {
		cards,
		sets,
		value: collectionValue(locals.user.id)
	};
}
