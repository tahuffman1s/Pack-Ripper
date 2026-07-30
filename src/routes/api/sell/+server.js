import { json, error } from '@sveltejs/kit';
import { sellCards } from '$lib/server/game.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const body = await request.json().catch(() => ({}));
	const uids = Array.isArray(body.uids) ? body.uids.map(String) : [];
	if (!uids.length) throw error(400, 'No cards selected.');
	const result = await sellCards(locals.user.id, uids);
	return json(result);
}
