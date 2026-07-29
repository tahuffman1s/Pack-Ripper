#!/usr/bin/env node
/**
 * Odds regression harness.
 *
 * Collates a large sample of packs for each set and checks the result against
 * what Wizards published. Run it after touching anything in collate.js — a
 * silent change to the sampler is otherwise invisible until a player notices
 * their packs feel wrong.
 *
 *   node scripts/verify-odds.mjs            # the default set list
 *   node scripts/verify-odds.mjs mkm dsk    # specific sets
 *   node scripts/verify-odds.mjs --n 500000 # bigger sample
 *
 * Expectations are stated as published-by-Wizards figures with a tolerance.
 * A failure means either the sampler regressed or MTGJSON's sheets changed.
 */

import { getCollation } from '../src/lib/server/collation.js';
import { generateFromVariant, makeRng, rarityAsFan, sheetMarginals } from '../src/lib/collate.js';
import { variantForProduct } from '../src/lib/server/opener.js';

const args = process.argv.slice(2);
const nIdx = args.indexOf('--n');
const N = nIdx >= 0 ? Number(args[nIdx + 1]) : 200000;
const only = args.filter((a) => !a.startsWith('--') && a !== String(N));

/**
 * Published expectations. Every figure here is a Wizards statement, not a
 * value read back out of the code.
 */
const EXPECTED = [
	{
		code: 'mkm',
		product: 'play',
		label: 'Murders at Karlov Manor — Play Booster',
		checks: [
			{ name: 'pack size always 14', get: (r) => r.sizes.size === 1 && r.sizes.has(14), want: true },
			{ name: 'rare/mythic as-fan', get: (r) => r.asFan, want: 1.4, tol: 0.1, note: 'Wizards: "slightly over 1.4"' },
			{ name: 'P(2+ rares)', get: (r) => r.multiRare, want: 0.41, tol: 0.02, note: 'Wizards: 41%' },
			{ name: 'rare slot mythic share', get: (r) => r.mythicShare, want: 1 / 7, tol: 0.005, note: 'Wizards: 1 in 7' },
			{ name: 'foil land rate', get: (r) => r.sheetP.foilBasic ?? 0, want: 0.2, tol: 0.005, note: 'Wizards: 20%' }
		]
	},
	{
		code: 'dsk',
		product: 'play',
		label: 'Duskmourn — Play Booster',
		checks: [
			{ name: 'pack size always 14', get: (r) => r.sizes.size === 1 && r.sizes.has(14), want: true },
			{ name: 'rare slot mythic share', get: (r) => r.mythicShare, want: 1 / 7, tol: 0.008, note: 'published 12.6+1.4+0.3 mythic / 85.7 total' }
		]
	},
	{
		code: 'fdn',
		product: 'play',
		label: 'Foundations — Play Booster',
		checks: [
			{ name: 'pack size always 14', get: (r) => r.sizes.size === 1 && r.sizes.has(14), want: true },
			{ name: 'rare slot mythic share', get: (r) => r.mythicShare, want: 1 / 7, tol: 0.008, note: 'published 12.8+1.5 mythic / 85.7 total' }
		]
	},
	{
		code: 'ltr',
		product: 'collector',
		label: 'Tales of Middle-earth — Collector Booster',
		checks: [
			{ name: 'P(serialized)', get: (r) => r.serialized, want: 0.0006503, tol: 0.0004, note: 'MTGJSON: 0.06503%' }
		]
	},
	{
		code: 'arn',
		product: 'draft',
		label: 'Arabian Nights — original booster',
		checks: [{ name: 'pack size always 8', get: (r) => r.sizes.size === 1 && r.sizes.has(8), want: true }]
	},
	{
		code: 'tmp',
		product: 'draft',
		label: 'Tempest — Draft Booster',
		checks: [{ name: 'pack size always 15', get: (r) => r.sizes.size === 1 && r.sizes.has(15), want: true }]
	}
];

async function measure(code, product, n) {
	const slice = await getCollation(code);
	if (!slice) return null;
	const variantKey = variantForProduct(slice, product);
	if (!variantKey) return null;
	const variant = slice.variants[variantKey];

	// The rare slot is whichever sheet the classifier called `rare`.
	const rareSheets = Object.entries(variant.sheets)
		.filter(([, s]) => s.kind === 'rare' && !s.foil)
		.map(([name]) => name);

	const rng = makeRng(0xc0ffee);
	const sizes = new Set();
	let rm = 0;
	let multi = 0;
	let mythicSlot = 0;
	let rareSlot = 0;
	let serialized = 0;

	for (let i = 0; i < n; i++) {
		const { picked } = generateFromVariant(variant, { rng, facts: slice.cards });
		sizes.add(picked.length);
		let hits = 0;
		let hasSerial = false;
		for (const p of picked) {
			const f = slice.cards[p.uuid];
			if (!f) continue;
			if (f.r === 'rare' || f.r === 'mythic') hits++;
			if (rareSheets.includes(p.sheet)) {
				if (f.r === 'mythic') mythicSlot++;
				else rareSlot++;
			}
			if ((f.p || []).includes('serialized')) hasSerial = true;
		}
		rm += hits;
		if (hits >= 2) multi++;
		if (hasSerial) serialized++;
	}

	const marg = sheetMarginals(variant);
	return {
		variantKey,
		sizes,
		asFan: rm / n,
		multiRare: multi / n,
		mythicShare: mythicSlot + rareSlot ? mythicSlot / (mythicSlot + rareSlot) : 0,
		serialized: serialized / n,
		sheetP: Object.fromEntries(Object.entries(marg).map(([k, v]) => [k, v.p])),
		analytic: rarityAsFan(variant, slice.cards)
	};
}

let failures = 0;
const targets = only.length ? EXPECTED.filter((e) => only.includes(e.code)) : EXPECTED;

for (const spec of targets) {
	const r = await measure(spec.code, spec.product, N);
	if (!r) {
		console.log(`\n${spec.label}\n  SKIP — no collation data for ${spec.code}/${spec.product}`);
		continue;
	}
	console.log(`\n${spec.label}  [variant: ${r.variantKey}, n=${N.toLocaleString()}]`);
	for (const c of spec.checks) {
		const got = c.get(r);
		let pass;
		let shown;
		if (typeof c.want === 'boolean') {
			pass = got === c.want;
			shown = String(got);
		} else {
			pass = Math.abs(got - c.want) <= c.tol;
			shown = `${got.toFixed(5)} vs ${c.want.toFixed(5)} ±${c.tol}`;
		}
		if (!pass) failures++;
		console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(26)} ${shown}${c.note ? `   (${c.note})` : ''}`);
	}
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
