import { json, error } from '@sveltejs/kit';
import { getPackImageData } from '$lib/server/tcgplayer.js';
import { getSetArt } from '$lib/server/scryfall.js';
import { setEntry } from '$lib/server/registry.js';

/**
 * Art for the 3D pack. Preference order:
 *   1. the real TCGplayer product photo of that exact booster pack (kind: product)
 *   2. a marquee card's art from the set (kind: art)
 *   3. nothing (the client draws a generated wrapper)
 * Images are returned as same-origin data URLs to avoid any canvas CORS taint.
 */

/** @type {import('./$types').RequestHandler} */
export async function GET({ params, url, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const type = url.searchParams.get('type') || '';
	const set = setEntry(params.code);
	const name = set?.name || params.code.toUpperCase();

	try {
		if (type) {
			const product = await getPackImageData(params.code, type, name);
			if (product) return json({ image: product, kind: 'product', name });
		}
		const a = await getSetArt(params.code);
		return json({ image: a.artData || a.art || null, kind: 'art', name });
	} catch {
		return json({ image: null, kind: 'none', name });
	}
}
