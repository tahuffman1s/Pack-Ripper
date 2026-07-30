import { inventorySummary, getOpenings, MASS_OPEN_MAX } from '$lib/server/game.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	const [groups, recent] = await Promise.all([
		inventorySummary(locals.user.id),
		getOpenings(locals.user.id)
	]);

	return {
		groups,
		recent: recent.slice(0, 6),
		massOpenMax: MASS_OPEN_MAX
	};
}
