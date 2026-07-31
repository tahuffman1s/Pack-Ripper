import { fail, redirect } from '@sveltejs/kit';
import { createUser, createSession, SESSION_COOKIE, sessionCookieOptions } from '$lib/server/auth.js';
import { startingGold } from '$lib/server/settings.js';

/**
 * The opening grant is an admin setting now, so the sign-up page has to be told
 * what it is rather than quoting the compiled constant — otherwise a server that
 * hands out a million advertises a hundred thousand.
 */
/** @type {import('./$types').PageServerLoad} */
export async function load() {
	return { startingGold: await startingGold() };
}

/** @type {import('./$types').Actions} */
export const actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const username = String(form.get('username') || '');
		const password = String(form.get('password') || '');

		let user;
		try {
			user = await createUser({ username, password });
		} catch (e) {
			return fail(400, { username, error: e.message || 'Could not create account.' });
		}
		const token = await createSession(user.id);
		cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
		throw redirect(303, '/');
	}
};
