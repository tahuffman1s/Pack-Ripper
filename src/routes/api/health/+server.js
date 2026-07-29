import { json } from '@sveltejs/kit';

// Liveness, for three callers: the image's HEALTHCHECK, run.sh's startup wait,
// and the Azure Container Apps probes in azure/deploy.sh.
//
// Reaching this handler already means the app is warm. hooks.server.js awaits
// ensureSets() before any response, so a 200 here is not just "the process is
// listening" — the Scryfall set list is loaded.
/** @type {import('./$types').RequestHandler} */
export function GET() {
	return json({ ok: true, app: 'packripper' }, { headers: { 'cache-control': 'no-store' } });
}
