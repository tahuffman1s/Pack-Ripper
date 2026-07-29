import { json, error } from '@sveltejs/kit';
import { runAdminAction, verifyAdminToken } from '$lib/server/admin.js';

/**
 * The one admin entry point. Two ways to authenticate:
 *
 *   - a signed-in admin's session cookie  (the /admin panel)
 *   - `Authorization: Bearer $ADMIN_TOKEN` (scripts/admin.mjs)
 *
 * Anything else gets a 404 rather than a 403, so an unauthenticated prod does not
 * confirm that an admin API exists here at all. The CLI knows better and says so.
 *
 * The body is JSON, which also keeps SvelteKit's CSRF check out of the way: it
 * only rejects cross-origin POSTs with a form content type, so a browser page on
 * another site cannot reach this without an admin's cookie AND a preflight the
 * app never grants.
 */

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	const header = request.headers.get('authorization') || '';
	const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

	/** @type {{name:string, via:'panel'|'cli', id:string|null}|null} */
	let actor = null;
	if (locals.user?.admin) {
		actor = { name: locals.user.username, via: 'panel', id: locals.user.id };
	} else if (bearer && verifyAdminToken(bearer)) {
		actor = { name: 'cli', via: 'cli', id: null };
	}
	// Authenticate before reading the body, so an unauthenticated caller never gets
	// as far as making us parse one.
	if (!actor) throw error(404, 'Not found');

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Expected a JSON body.');

	if (actor.via === 'cli') {
		// The token says the caller is trusted but not who they are, so the CLI
		// volunteers an operator name for the audit trail. Sanitised and prefixed,
		// because it is caller-supplied text: `cli:travis` can never be mistaken in
		// the log for the signed-in admin `travis`.
		const who = String(body.as || '')
			.replace(/[^a-zA-Z0-9_.-]/g, '')
			.slice(0, 24);
		if (who) actor.name = `cli:${who}`;
	}

	const result = runAdminAction(actor, body.action, body);
	if (!result.ok) throw error(400, result.error);
	return json(result, { headers: { 'cache-control': 'no-store' } });
}
