import { json, error } from '@sveltejs/kit';
import { openPack } from '$lib/server/game.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const body = await request.json().catch(() => ({}));
	const result = await openPack(locals.user.id, body.inventoryId);
	if (!result.ok) throw error(400, result.error || 'Could not open pack.');
	return json(result);
}
