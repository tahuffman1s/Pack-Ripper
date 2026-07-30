#!/usr/bin/env node
/**
 * Import a legacy .data/db.json into Postgres, by hand.
 *
 * The app does this itself on first boot against an empty database, so this
 * script is for the cases where that is not what you want:
 *
 *   - checking what a migration WILL do, with --dry-run, before starting the app
 *   - importing into a database the app is not running against yet
 *   - re-running it after a deliberate wipe
 *
 * Needs the repo (it imports the app's own modules, so there is exactly one
 * implementation of the mapping) and a DATABASE_URL. From inside the container
 * the app has already done it; there is nothing to run there.
 *
 *   DATABASE_URL=postgres://packripper:pw@localhost:5432/packripper \
 *     node scripts/import-json-db.js [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDb, query } from '../src/lib/server/db.js';
import { importLegacyJson } from '../src/lib/server/importJson.js';

const dryRun = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL && !process.env.PGHOST && !process.env.PGUSER) {
	console.error(
		'No DATABASE_URL (and no PGHOST/PGUSER) in the environment — refusing to guess.\n' +
			'  DATABASE_URL=postgres://user:pw@host:5432/packripper node scripts/import-json-db.js'
	);
	process.exit(1);
}

const source = ['db.json', 'db.json.bak', 'db.json.tmp']
	.map((f) => join(process.cwd(), '.data', f))
	.find((p) => existsSync(p));

if (!source) {
	console.error(`Nothing to import: no .data/db.json under ${process.cwd()}.`);
	process.exit(1);
}

if (dryRun) {
	// Deliberately does not connect. A dry run is for reading the file, and asking
	// it to also prove it can reach a database it will not write to is a way to
	// fail for the wrong reason.
	const db = JSON.parse(readFileSync(source, 'utf-8'));
	const count = (o) => (Array.isArray(o) ? o.length : Object.keys(o || {}).length);
	const nested = (o) => Object.values(o || {}).reduce((a, l) => a + count(l), 0);

	console.log(`Would import from ${source}:`);
	console.log(`  users       ${count(db.users)}`);
	console.log(`  sessions    ${count(db.sessions)}`);
	console.log(`  packs       ${nested(db.inventory)}`);
	console.log(`  cards       ${nested(db.collections)}`);
	console.log(`  openings    ${nested(db.openings)}`);
	console.log(`  serials     ${nested(db.serials)}`);
	console.log(`  bj tables   ${count(db.blackjack)}`);
	console.log(`  free spins  ${count(db.freeSpins)}`);
	console.log(`  admin log   ${count(db.adminLog)}`);
	console.log(
		`  gold        ${Object.values(db.wallets || {})
			.reduce((a, w) => a + (w?.gold || 0), 0)
			.toLocaleString('en-US')}`
	);
	console.log('\n--dry-run: nothing was written and no connection was made.');
	process.exit(0);
}

await initDb();

const { rows } = await query('SELECT count(*)::int AS n FROM users');
if (rows[0].n > 0) {
	console.error(
		`Refusing to import: the database already holds ${rows[0].n} account(s).\n` +
			'This only ever runs against an empty database — it adds accounts and never ' +
			'replaces them, and that guard is what makes it safe to leave enabled at boot.'
	);
	process.exit(1);
}

const summary = await importLegacyJson();
if (!summary) {
	console.error('Nothing was imported — the file had no accounts in it.');
	process.exit(1);
}

process.exit(0);
