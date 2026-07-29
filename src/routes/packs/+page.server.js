import { inventorySummary, getOpenings, MASS_OPEN_MAX } from '$lib/server/game.js';

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	return {
		groups: inventorySummary(locals.user.id),
		recent: getOpenings(locals.user.id).slice(0, 6),
		massOpenMax: MASS_OPEN_MAX
	};
}
