import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What is running, and where it came from.
 *
 * "Which version is on the Pi?" has to be answerable from inside the container,
 * and the container has no git checkout in it and cannot read its own image tag.
 * So the commit is baked in at build time as an env var (see the Dockerfile's
 * GIT_SHA arg and the build-args the image workflow passes it), and read back
 * here.
 *
 * Outside a container — `vite dev` on a working copy — none of those exist, so
 * the same fields are read from git directly, which also picks up uncommitted
 * changes. That makes the panel's version line mean "the code I am looking at"
 * in development and "the image that got deployed" in production, without the
 * two disagreeing about what they are showing.
 *
 * Everything here is best-effort and computed exactly once. A missing version is
 * displayed as unknown; it is never a reason for the panel not to load.
 */

const ENV_SHA = process.env.GIT_SHA || '';
const ENV_REF = process.env.GIT_REF || '';
const ENV_BUILT_AT = process.env.BUILD_TIME || '';

/** `git`, but never throwing and never hanging a request. */
function git(...args) {
	try {
		return execFileSync('git', args, {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return '';
	}
}

function packageVersion() {
	try {
		const path = join(process.cwd(), 'package.json');
		if (!existsSync(path)) return '';
		return JSON.parse(readFileSync(path, 'utf-8')).version || '';
	} catch {
		return '';
	}
}

let memo = null;

/**
 * @returns {{version:string, commit:string, shortCommit:string, ref:string,
 *   builtAt:string|null, committedAt:string|null, dirty:boolean,
 *   source:'image'|'git'|'unknown', node:string}}
 */
export function versionInfo() {
	if (memo) return memo;

	const fromImage = !!ENV_SHA;
	const commit = fromImage ? ENV_SHA : git('rev-parse', 'HEAD');
	// A working copy with uncommitted changes is not the commit it says it is, and
	// that is worth seeing on a page whose job is to tell you what is running.
	// Never true for an image: the build copies a clean checkout.
	const dirty = fromImage ? false : !!git('status', '--porcelain');

	memo = {
		version: packageVersion(),
		commit,
		shortCommit: commit ? commit.slice(0, 7) : '',
		ref: fromImage ? ENV_REF : git('rev-parse', '--abbrev-ref', 'HEAD'),
		builtAt: ENV_BUILT_AT || null,
		committedAt: fromImage ? null : git('show', '-s', '--format=%cI', 'HEAD') || null,
		dirty,
		source: commit ? (fromImage ? 'image' : 'git') : 'unknown',
		node: process.version
	};
	return memo;
}
