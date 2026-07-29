import { json, error } from '@sveltejs/kit';
import { rescue } from '$lib/server/rescue.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	// Eligibility is decided server-side: rescue() refuses unless the player
	// genuinely has no move left, so this cannot be claimed on demand.
	const result = await rescue(locals.user.id);
	if (!result.ok) throw error(400, result.error);
	return json(result);
}
