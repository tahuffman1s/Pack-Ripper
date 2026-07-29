import { json, error } from '@sveltejs/kit';
import { sellPacks } from '$lib/server/game.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const body = await request.json().catch(() => ({}));
	const setCode = String(body.setCode || '');
	const packTypeId = String(body.packTypeId || '');
	const qty = Math.max(1, parseInt(body.qty, 10) || 1);
	const result = sellPacks(locals.user.id, { setCode, packTypeId, qty });
	if (!result.ok) throw error(400, result.error || 'Could not sell packs.');
	return json(result);
}
