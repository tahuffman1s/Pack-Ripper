import { json } from '@sveltejs/kit';

// Liveness, for three callers: the image's HEALTHCHECK, run.sh's startup wait,
// and the GitHub Pages redirector — which is why the CORS header is here. That
// page runs on github.io and has to tell "this tunnel is serving PackRipper"
// apart from "the hostname is dead", and a cross-origin fetch without the
// header cannot report the difference: both look like a network error.
//
// Reaching this handler already means the app is warm. hooks.server.js awaits
// ensureSets() before any response, so a 200 here is not just "the process is
// listening" — the Scryfall set list is loaded.
const HEADERS = {
	'access-control-allow-origin': '*',
	'cache-control': 'no-store'
};

/** @type {import('./$types').RequestHandler} */
export function GET() {
	return json({ ok: true, app: 'packripper' }, { headers: HEADERS });
}
