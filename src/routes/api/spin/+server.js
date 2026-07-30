import { json, error } from '@sveltejs/kit';
import { spin } from '$lib/server/slots.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	// Stake and line count are the only things the client supplies, and spin()
	// validates both against the published allow-lists and the balance. The
	// outcome is rolled server-side, and during a free-spin round the stake is
	// taken from stored state and these are ignored entirely.
	const body = await request.json().catch(() => ({}));
	const bet = Number(body?.bet);
	const lines = Number(body?.lines);
	const result = await spin(locals.user.id, {
		bet: Number.isFinite(bet) ? bet : undefined,
		lines: Number.isFinite(lines) ? lines : undefined
	});
	if (!result.ok) throw error(400, result.error);
	return json(result);
}
