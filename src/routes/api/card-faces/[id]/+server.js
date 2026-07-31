import { json, error } from '@sveltejs/kit';
import { getCardFaces } from '$lib/server/scryfall.js';

/**
 * Both faces of a printing, so the 3D viewer can show the real back of a
 * double-faced card instead of a card back.
 *
 * Asked for lazily, once per card the player actually opens, and answered from a
 * disk cache after the first time — see getCardFaces for why this is an endpoint
 * rather than a field on the stored card. A card the lookup cannot resolve gets an
 * empty list and the viewer draws its printed back, which is the right answer for
 * the overwhelming majority of cards anyway.
 */

/** @type {import('./$types').RequestHandler} */
export async function GET({ params, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');

	const record = await getCardFaces(params.id);

	return json(
		record ?? { layout: 'normal', faces: [] },
		{
			// A printing's faces are immutable, so this is as cacheable as anything in
			// the app gets. Private, because the response is behind a session.
			headers: { 'cache-control': 'private, max-age=86400' }
		}
	);
}
