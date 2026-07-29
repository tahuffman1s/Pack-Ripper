import { redirect } from '@sveltejs/kit';
import { destroySession, SESSION_COOKIE } from '$lib/server/auth.js';

/** @type {import('./$types').Actions} */
export const actions = {
	default: async ({ cookies }) => {
		const token = cookies.get(SESSION_COOKIE);
		destroySession(token);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw redirect(303, '/login');
	}
};

/** GET on /logout just bounces home. */
export function load() {
	throw redirect(303, '/');
}
