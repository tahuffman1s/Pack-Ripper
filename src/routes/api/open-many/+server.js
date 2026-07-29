import { json, error } from '@sveltejs/kit';
import { openPacks } from '$lib/server/game.js';

/** Mass rip: open a whole stack of identical packs in one request. */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const body = await request.json().catch(() => ({}));
	const result = await openPacks(locals.user.id, {
		setCode: body.setCode,
		packTypeId: body.packTypeId,
		ids: body.ids,
		count: body.count
	});
	if (!result.ok) throw error(400, result.error || 'Could not open those packs.');
	return json(result);
}
