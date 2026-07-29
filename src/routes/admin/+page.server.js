import { error } from '@sveltejs/kit';
import { summary, listUsers, auditLog, grantableSets } from '$lib/server/admin.js';
import { PACK_TYPE_ORDER } from '$lib/packs.js';

/**
 * The panel is a 404 for everyone who is not an admin — not a 403. A "forbidden"
 * tells anyone who guesses the URL that there is something here worth attacking.
 * The nav link only renders for admins, so nobody who should be here has to guess.
 *
 * Every mutation goes through POST /api/admin (see that endpoint), which the page
 * calls with fetch. This load is read-only.
 */

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	if (!locals.user?.admin) throw error(404, 'Not found');

	return {
		summary: summary(),
		users: listUsers(),
		log: auditLog(40),
		sets: grantableSets(),
		packTypeOrder: PACK_TYPE_ORDER
	};
}
