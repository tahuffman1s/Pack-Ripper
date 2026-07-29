import { json, error } from '@sveltejs/kit';
import { deal, act } from '$lib/server/blackjack.js';

const MOVES = new Set(['hit', 'stand', 'double', 'split']);

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const body = await request.json().catch(() => ({}));
	const action = String(body?.action || '');

	// Every action is re-validated against server-held table state, so the
	// client cannot double on a five-card hand or split a non-pair.
	let result;
	if (action === 'deal') {
		const bet = Number(body?.bet);
		result = deal(locals.user.id, Number.isFinite(bet) ? bet : NaN);
	} else if (MOVES.has(action)) {
		result = act(locals.user.id, action);
	} else {
		throw error(400, 'Unknown action.');
	}

	if (!result.ok) throw error(400, result.error);
	return json(result);
}
