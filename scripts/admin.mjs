#!/usr/bin/env node
/**
 * PackRipper admin CLI.
 *
 * Talks to a *running* app over HTTP and authenticates with the shared secret in
 * ADMIN_TOKEN. It deliberately does not connect to Postgres directly. It could —
 * the old reason it could not (the app held everything in memory and would
 * overwrite any outside edit) is gone — but going through the app means this needs
 * no database credentials, gets the same validation as the panel, and lands every
 * action in the same audit log.
 *
 * Run it from the repo on the host, or from inside the container, where the image
 * puts it on the PATH as `admin` — that one is typed by hand in a remote shell,
 * so it is worth being short:
 *
 *   ./admin.sh gold travis 50000
 *   podman exec packripper admin gold travis 50000
 *   admin gold travis 50000                          (from a console inside it)
 *
 * Configuration, all overridable per-invocation:
 *
 *   ADMIN_TOKEN     the shared secret, matching the app's own ADMIN_TOKEN   (--token)
 *   PACKRIPPER_URL  where the app is; defaults to http://127.0.0.1:$PORT,    (--url)
 *                   which is right both on the host and inside the container
 *   ADMIN_ACTOR     the name recorded in the audit log; defaults to the OS  (--as)
 *                   user, which inside the container is `root`
 *
 * Bootstrapping: a fresh database has no admins. Set ADMIN_USERNAMES=<you> on the
 * container and that account is an admin from its next sign-in — that is what the
 * panel is for. ADMIN_TOKEN is what this CLI is for. Neither depends on the other.
 */

import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';

/**
 * How to spell this command back at whoever ran it. Inside the container the repo
 * wrapper does not exist — telling someone in a `docker exec` shell to run
 * `./admin.sh` sends them looking for a file that is not there.
 *
 * The image copies this script to a fixed path, which is what makes the test
 * reliable: /app/admin.mjs is only ever the containerised copy.
 */
const SELF = process.argv[1] || '';
const ME = SELF === '/app/admin.mjs' || SELF.endsWith('/usr/local/bin/admin') ? 'admin' : './admin.sh';

const HELP = `
PackRipper admin — commands run against a running app.

  usage: ${ME} <command> [args] [--url URL] [--token TOKEN] [--as NAME] [--json]

Accounts
  list                              every account, richest first
  show <user>                       one account in full
  find <text>                       accounts whose name contains text

Gold
  gold <user> <amount>              add gold (a negative amount takes it away)
  gold <user> <amount> --set        set the balance outright

Packs
  packs <user> <set> <product> [n]  grant n unopened packs, free
                                    product: draft set play jumpstart mystery collector

Access
  admin <user>                      grant admin (the panel at /admin)
  admin <user> off                  revoke it
  passwd <user> <password>          set a password; signs them out everywhere
  logout <user>                     sign them out everywhere

Repair
  unstick <user>                    clear a wedged blackjack hand / free spins
  reset-stats <user>                zero the statistics, keep wallet and cards
  delete <user> --yes               delete the account and everything on it

Server
  status                            version, health, totals, uptime
  db-reset --confirm RESET          wipe every player's progress, keep accounts
  log [n]                           the admin audit trail (default 30)
  token                             generate a value for ADMIN_TOKEN

  <user> is a username or an account id. Usernames are case-insensitive.
`;

// ── arguments ──────────────────────────────────────────────────
// Only `--x` is a flag, so a negative gold amount stays a positional argument.
const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a.startsWith('--')) {
		const [name, inline] = a.slice(2).split('=');
		if (inline !== undefined) flags[name] = inline;
		else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
		else flags[name] = true;
	} else {
		args.push(a);
	}
}

const command = args.shift() || 'help';

// Deliberately NOT falling back to ORIGIN. That variable is how *browsers* reach
// the app — in production a public https:// hostname — and inside the container it is
// not reachable from loopback at all. A local process always finds the app on
// 127.0.0.1:$PORT; anything else is a remote app and says so with --url.
const BASE = String(
	flags.url || process.env.PACKRIPPER_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
).replace(/\/+$/, '');
const TOKEN = String(flags.token || process.env.ADMIN_TOKEN || '');

// Who to blame in the audit log. The token proves the caller is trusted but says
// nothing about which person is holding it, so send a name — the OS user by
// default, ADMIN_ACTOR when that is not meaningful (inside the container it is
// `root`, so set it there if more than one person has the token).
const ACTOR = (() => {
	try {
		return String(flags.as || process.env.ADMIN_ACTOR || userInfo().username || '');
	} catch {
		return String(flags.as || process.env.ADMIN_ACTOR || '');
	}
})();

// ── output ─────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const c = tty
	? { b: '\x1b[1m', dim: '\x1b[2m', r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', n: '\x1b[0m' }
	: { b: '', dim: '', r: '', g: '', y: '', n: '' };

const ok = (s) => console.log(`${c.g}  ok${c.n} ${s}`);
const info = (s) => console.log(`${c.dim}${s}${c.n}`);

function die(message, hint) {
	console.error(`${c.r}fail${c.n} ${message}`);
	if (hint) console.error(`${c.dim}     ${hint}${c.n}`);
	process.exit(1);
}

const num = (n) => Number(n || 0).toLocaleString('en-US');

function when(ms) {
	if (!ms) return '—';
	return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** Left-aligned columns, right-aligned numbers, sized to the content. */
function table(rows, columns) {
	if (!rows.length) return info('  (nothing)');
	const cells = rows.map((row) => columns.map((col) => String(col.value(row) ?? '')));
	const widths = columns.map((col, i) =>
		Math.max(col.label.length, ...cells.map((line) => line[i].length))
	);
	const pad = (s, i) => (columns[i].right ? s.padStart(widths[i]) : s.padEnd(widths[i]));

	console.log('  ' + c.dim + columns.map((col, i) => pad(col.label, i)).join('  ') + c.n);
	for (const line of cells) console.log('  ' + line.map(pad).join('  '));
}

// ── transport ──────────────────────────────────────────────────
async function api(action, body = {}) {
	if (!TOKEN) {
		die(
			'no ADMIN_TOKEN.',
			`Set ADMIN_TOKEN on the container and in .env (${ME} token generates one).`
		);
	}

	let res;
	try {
		res = await fetch(`${BASE}/api/admin`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ action, as: ACTOR, ...body })
		});
	} catch (e) {
		die(`cannot reach ${BASE} — ${e.cause?.code || e.message}`, 'Is the container running? Override with --url.');
	}

	const payload = await res.json().catch(() => ({}));
	if (res.status === 404) {
		die(
			'the app rejected the token.',
			'ADMIN_TOKEN here must match the one in the container environment, and the app must have been restarted since it was set.'
		);
	}
	if (!res.ok) die(payload.message || `${action} failed (HTTP ${res.status}).`);
	return payload;
}

/** Print the raw JSON instead, when asked. Handy for piping into jq. */
function maybeJson(payload) {
	if (!flags.json) return false;
	console.log(JSON.stringify(payload, null, 2));
	return true;
}

// ── commands ───────────────────────────────────────────────────
const need = (n, usage) => {
	if (args.length < n) die(`not enough arguments.`, `usage: ${usage}`);
};

const USER_COLUMNS = [
	{ label: 'USER', value: (u) => u.username + (u.admin ? ' *' : '') },
	{ label: 'GOLD', value: (u) => num(u.gold), right: true },
	{ label: 'CARDS', value: (u) => num(u.cards), right: true },
	{ label: 'VALUE', value: (u) => num(u.collectionValue), right: true },
	{ label: 'PACKS', value: (u) => num(u.packs), right: true },
	{ label: 'OPENED', value: (u) => num(u.packsOpened), right: true },
	{ label: 'LAST SEEN', value: (u) => when(u.lastSeenAt) },
	{ label: 'ID', value: (u) => u.id }
];

async function cmdList(filter) {
	const { users } = await api('users');
	if (maybeJson({ users })) return;
	const rows = filter
		? users.filter((u) => u.username.toLowerCase().includes(filter.toLowerCase()))
		: users;
	table(rows, USER_COLUMNS);
	info(`  ${rows.length} account(s); * = admin`);
}

async function cmdShow() {
	need(1, 'show <user>');
	const { user } = await api('user', { user: args[0] });
	if (maybeJson({ user })) return;
	const s = user.stats || {};
	console.log(`${c.b}${user.username}${c.n}${user.admin ? `  ${c.r}[admin]${c.n}` : ''}`);
	console.log(`  id            ${user.id}`);
	console.log(`  joined        ${when(user.createdAt)}`);
	console.log(`  last seen     ${when(user.lastSeenAt)}  (${user.sessions} live session(s))`);
	console.log(`  gold          ${num(user.gold)}`);
	console.log(`  collection    ${num(user.cards)} cards, worth ${num(user.collectionValue)} gold`);
	console.log(`  unopened      ${num(user.packs)} packs`);
	console.log(`  opened        ${num(s.packsOpened)} packs / ${num(s.cardsOpened)} cards`);
	console.log(`  pulled        ${num(s.mythicsPulled)} mythic, ${num(s.raresPulled)} rare, ${num(s.foilsPulled)} foil`);
	console.log(`  gold flow     +${num(s.goldEarned)} earned / -${num(s.goldSpent)} spent`);
	// Net of every admin adjustment, so it goes negative when a balance was set down.
	if (s.adminGranted) console.log(`  admin adj.    ${s.adminGranted > 0 ? '+' : ''}${num(s.adminGranted)} gold`);
	if (s.bestPull) console.log(`  best pull     ${s.bestPull.name} (${num(s.bestPull.gold)} gold)`);
	if (user.atTable) console.log(`  ${c.y}mid-hand at the blackjack table${c.n}`);
	if (user.freeSpins) console.log(`  ${c.y}${user.freeSpins} free spins outstanding${c.n}`);
}

async function cmdGold() {
	need(2, 'gold <user> <amount> [--set]');
	const amount = Number(args[1]);
	if (!Number.isFinite(amount)) die(`"${args[1]}" is not a number.`);
	const r = await api('gold', { user: args[0], amount, set: !!flags.set });
	if (maybeJson(r)) return;
	ok(`${r.user}: ${num(r.before)} → ${num(r.after)} gold (${r.delta >= 0 ? '+' : ''}${num(r.delta)})`);
}

async function cmdPacks() {
	need(3, 'packs <user> <set> <product> [qty]');
	const r = await api('packs', {
		user: args[0],
		setCode: args[1],
		packTypeId: args[2],
		qty: args[3] ? Number(args[3]) : 1
	});
	if (maybeJson(r)) return;
	ok(
		`${r.user}: +${num(r.granted)} ${r.setCode.toUpperCase()} ${r.packTypeId} booster(s), ` +
			`worth ${num(r.worth)} gold — ${num(r.packs)} unopened in the vault now`
	);
}

async function cmdAdmin() {
	need(1, 'admin <user> [off]');
	const off = ['off', 'false', 'no', 'revoke'].includes(String(args[1] || '').toLowerCase());
	const r = await api('admin', { user: args[0], value: !off });
	if (maybeJson(r)) return;
	ok(r.admin ? `${r.user} is an admin — /admin is now theirs.` : `${r.user} is no longer an admin.`);
}

async function cmdPasswd() {
	need(2, 'passwd <user> <password>');
	const r = await api('password', { user: args[0], password: args[1] });
	if (maybeJson(r)) return;
	ok(`password set for ${r.user}; ${r.sessionsRevoked} session(s) signed out.`);
}

async function cmdLogout() {
	need(1, 'logout <user>');
	const r = await api('logout', { user: args[0] });
	if (maybeJson(r)) return;
	ok(`${r.user}: ${r.sessionsRevoked} session(s) revoked.`);
}

async function cmdUnstick() {
	need(1, 'unstick <user>');
	const r = await api('unstick', { user: args[0] });
	if (maybeJson(r)) return;
	ok(
		`${r.user}: table ${r.cleared.table ? 'cleared' : 'was empty'}, ` +
			`free spins ${r.cleared.freeSpins ? `cleared (${r.cleared.freeSpins} forfeited)` : 'none'}.`
	);
}

async function cmdResetStats() {
	need(1, 'reset-stats <user>');
	const r = await api('reset-stats', { user: args[0] });
	if (maybeJson(r)) return;
	ok(`${r.user}: statistics zeroed (wallet and cards untouched).`);
}

async function cmdDelete() {
	need(1, 'delete <user> --yes');
	if (!flags.yes) die('refusing to delete without --yes.', `usage: delete ${args[0]} --yes`);
	const r = await api('delete', { user: args[0], confirm: true });
	if (maybeJson(r)) return;
	ok(
		`deleted ${r.user} — ${num(r.removed.cards)} cards, ${num(r.removed.packs)} packs, ` +
			`${num(r.removed.gold)} gold.`
	);
}

/**
 * Wipe every player's progress. The word is spelled out rather than accepted as
 * a --yes flag, because --yes is muscle memory and this is not the command to
 * lose an argument-order argument with.
 */
async function cmdDbReset() {
	if (flags.confirm !== 'RESET') {
		die(
			'refusing to reset without --confirm RESET.',
			'usage: db-reset --confirm RESET   (wipes all cards, packs, stats and gold; keeps accounts)'
		);
	}
	const r = await api('db-reset', { confirm: 'RESET' });
	if (maybeJson(r)) return;
	ok(
		`database reset — wiped ${num(r.cardsWiped)} cards and ${num(r.packsWiped)} packs, released ` +
			`${num(r.serialsReleased)} serials, set ${num(r.accountsKept)} wallet(s) to ${num(r.goldEach)} gold.`
	);
}

async function cmdLog() {
	const { log } = await api('log', { limit: Number(args[0]) || 30 });
	if (maybeJson({ log })) return;
	table(log, [
		{ label: 'WHEN', value: (e) => when(e.at) },
		{ label: 'ACTION', value: (e) => e.action },
		{ label: 'TARGET', value: (e) => e.target || '' },
		{ label: 'BY', value: (e) => e.actor },
		{ label: 'DETAIL', value: (e) => e.detail || '' }
	]);
}

async function cmdStatus() {
	let health = null;
	try {
		const res = await fetch(`${BASE}/api/health`);
		health = res.ok ? await res.json().catch(() => ({})) : null;
	} catch {
		health = null;
	}

	const { summary, log } = await api('overview');
	if (maybeJson({ health, summary })) return;

	console.log(`${c.b}${BASE}${c.n}`);
	console.log(`  health        ${health?.ok ? `${c.g}ok${c.n}` : `${c.y}no answer on /api/health${c.n}`}`);
	// Which build answered. The first line to read after a deploy: `latest` says
	// nothing about which image a host has actually pulled.
	const v = summary.version;
	if (v) {
		const commit = v.shortCommit || `${c.y}unknown${c.n}`;
		const marks = [v.ref, v.source === 'git' ? 'working copy' : null, v.dirty ? `${c.y}modified${c.n}` : null]
			.filter(Boolean)
			.join(', ');
		console.log(`  version       ${v.version ? `v${v.version} ` : ''}${commit}${marks ? `  (${marks})` : ''}`);
		const stamp = v.builtAt || v.committedAt;
		if (stamp) console.log(`                ${v.builtAt ? 'built' : 'committed'} ${when(Date.parse(stamp))}`);
	}
	console.log(`  node          ${summary.nodeVersion}`);
	console.log(`  uptime        ${Math.floor(summary.uptimeSeconds / 3600)}h ${Math.floor((summary.uptimeSeconds % 3600) / 60)}m`);
	console.log(`  accounts      ${num(summary.users)} (${num(summary.admins)} admin)`);
	console.log(`  sessions      ${num(summary.sessions)}`);
	console.log(`  gold          ${num(summary.gold)} in circulation`);
	console.log(`  cards         ${num(summary.cards)} owned, ${num(summary.serialsIssued)} serials issued`);
	console.log(`  packs         ${num(summary.packs)} unopened, ${num(summary.tablesOpen)} table(s) in play`);

	// Whether the app is talking to its database, and to which one. This used to be
	// the most important line after a deploy, because a share that had not mounted
	// looked exactly like a first boot to the app and only it knew which it had
	// decided; Postgres does not have that failure mode, so it is now just status.
	const st = summary.storage;
	if (st) {
		const state = !st.ready ? `${c.r}NOT CONNECTED${c.n}` : st.error ? `${c.y}degraded${c.n}` : `${c.g}connected${c.n}`;
		console.log(`  database      ${state}  ${st.serverVersion || 'postgres'}`);
		console.log(
			`                ${st.database || '?'}${st.host ? ` @ ${st.host}` : ''}` +
				`, ${num(st.usersAtBoot)} account(s) at boot` +
				(st.bytes != null ? `, ${(st.bytes / 1024 / 1024).toFixed(1)} MB` : '')
		);
		if (st.pool) {
			console.log(
				`                pool ${st.pool.total} open, ${st.pool.idle} idle` +
					(st.pool.waiting ? `, ${c.y}${st.pool.waiting} waiting${c.n}` : '')
			);
		}
		if (!st.ready) {
			console.log(`  ${c.r}!${c.n}             check DATABASE_URL and that the db container is up`);
		}
		if (st.error) console.log(`  ${c.y}!${c.n}             last error: ${st.error}`);
		if (st.imported) {
			console.log(
				`  ${c.g}+${c.n}             imported ${num(st.imported.inDatabase?.users ?? 0)} account(s) / ` +
					`${num(st.imported.inDatabase?.cards ?? 0)} card(s) from ${st.imported.source} on this boot`
			);
		}
	}
	if (summary.envAdmins.length) console.log(`  ADMIN_USERNAMES  ${summary.envAdmins.join(', ')}`);
	if (log?.length) {
		console.log(`  last action   ${log[0].action} ${log[0].target || ''} by ${log[0].actor} at ${when(log[0].at)}`);
	}
}

function cmdToken() {
	const token = randomBytes(32).toString('base64url');
	console.log(token);
	if (tty) {
		info('\n  Put this in .env where the app reads it, then restart the container:');
		info(`    .env                ADMIN_TOKEN=${token}`);
		info('    on a server         deploy/<host>/.env, then: docker compose up -d');
	}
}

// ── dispatch ───────────────────────────────────────────────────
const COMMANDS = {
	list: () => cmdList(null),
	users: () => cmdList(null),
	find: () => {
		need(1, 'find <text>');
		return cmdList(args[0]);
	},
	show: cmdShow,
	gold: cmdGold,
	packs: cmdPacks,
	admin: cmdAdmin,
	passwd: cmdPasswd,
	password: cmdPasswd,
	logout: cmdLogout,
	unstick: cmdUnstick,
	'reset-stats': cmdResetStats,
	delete: cmdDelete,
	'db-reset': cmdDbReset,
	log: cmdLog,
	status: cmdStatus,
	token: cmdToken,
	help: () => console.log(HELP.trim())
};

const run = COMMANDS[command] || COMMANDS[command.replace(/^--?/, '')];
if (!run) die(`unknown command "${command}".`, `try ${ME} help`);

try {
	await run();
} catch (e) {
	die(e.message);
}
