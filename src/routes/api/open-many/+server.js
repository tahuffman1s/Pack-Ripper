import { error } from '@sveltejs/kit';
import { openPacks } from '$lib/server/game.js';

/**
 * Mass rip: open a whole stack of packs in one request.
 *
 * The response is a stream of newline-delimited JSON rather than one object,
 * because a rip has no size limit: ripping ten thousand packs takes long enough
 * that a silent connection would look hung and might well be cut by a proxy
 * before it finished. Each line is `{type:'progress'}` as a chunk of packs is
 * banked, and the last line is `{type:'done'}` or `{type:'error'}`.
 *
 * Errors after the first byte cannot be an HTTP status, so they arrive as that
 * final line instead — the client reads the stream to the end either way.
 */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not signed in');
	const body = await request.json().catch(() => ({}));
	const userId = locals.user.id;

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
			try {
				const result = await openPacks(userId, {
					setCode: body.setCode,
					packTypeId: body.packTypeId,
					ids: body.ids,
					count: body.count,
					onProgress: (p) => send({ type: 'progress', ...p })
				});
				send(
					result.ok
						? { type: 'done', ...result }
						: { type: 'error', error: result.error || 'Could not open those packs.' }
				);
			} catch (e) {
				send({ type: 'error', error: String(e?.message || e) });
			}
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'application/x-ndjson',
			'cache-control': 'no-store',
			// Nothing here should be buffered by a reverse proxy — the whole point
			// is that the counter moves while the rip is still running.
			'x-accel-buffering': 'no'
		}
	});
}
