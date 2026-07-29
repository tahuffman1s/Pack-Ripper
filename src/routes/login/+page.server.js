import { fail, redirect } from '@sveltejs/kit';
import { verifyUser, createSession, SESSION_COOKIE, sessionCookieOptions } from '$lib/server/auth.js';

/** @type {import('./$types').Actions} */
export const actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const username = String(form.get('username') || '');
		const password = String(form.get('password') || '');

		const user = verifyUser(username, password);
		if (!user) {
			return fail(400, { username, error: 'Invalid username or password.' });
		}
		const token = createSession(user.id);
		cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
		throw redirect(303, '/');
	}
};
