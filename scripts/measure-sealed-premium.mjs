#!/usr/bin/env node
/**
 * Measures the vintage sealed premium — how far above the value of its singles
 * an old booster pack actually trades.
 *
 * Pairs every pre-2006 set that has BOTH a live TCGplayer sealed price and an
 * exactly-computed pack EV, then fits the ratio against age. The coefficients it
 * prints are the ones baked into `sealedPremium()` in src/lib/pricing.js — re-run
 * this and update them when card or sealed prices have moved substantially.
 *
 * Slow on a cold cache: it crawls Scryfall prints for every vintage set.
 */

const R = '/var/mnt/GD2/Backup/Documents/Repositories/packripper/src/lib';
const { ensureSets, storeSets } = await import(`${R}/server/registry.js`);
const { fetchSetSealed, getSealed } = await import(`${R}/server/tcgplayer.js`);
const { getCollation } = await import(`${R}/server/collation.js`);
const { packEvUsd } = await import(`${R}/server/packvalue.js`);

await ensureSets();
const YEAR = 365.25 * 24 * 60 * 60 * 1000;
const NOW = Date.now();

// Every set old enough that MSRP-based pricing is meaningless. Sorted oldest
// first so the most informative data points come back even if this is cut short.
const vintage = storeSets()
	.filter((s) => s.released && Date.parse(s.released) < Date.parse('2006-01-01'))
	.sort((a, b) => Date.parse(a.released) - Date.parse(b.released));

console.log(`${vintage.length} pre-2006 sets in the store\n`);
console.log('set   year  age   product   live pack     EV/pack    ratio');
console.log('-----------------------------------------------------------');

const rows = [];
for (const s of vintage) {
	try {
		await fetchSetSealed(s.code, s.name);
	} catch {
		/* keep going */
	}
	const sealed = getSealed(s.code) || {};
	for (const type of s.packTypes) {
		const live = sealed[type]?.pack;
		if (!(live > 0)) continue;
		let ev = null;
		try {
			await getCollation(s.code);
			ev = await packEvUsd(s.code, type);
		} catch {
			ev = null;
		}
		if (!(ev > 0)) continue;
		const age = (NOW - Date.parse(s.released)) / YEAR;
		const ratio = live / ev;
		rows.push({ code: s.code, year: s.released.slice(0, 4), age, type, live, ev, ratio });
		console.log(
			`${s.code.padEnd(5)} ${s.released.slice(0, 4)}  ${age.toFixed(1).padStart(4)}  ${type.padEnd(9)} ` +
				`$${live.toFixed(2).padStart(10)} $${ev.toFixed(2).padStart(10)}   ${ratio.toFixed(2).padStart(6)}x`
		);
	}
}

if (!rows.length) {
	console.log('\nno sets have both a live price and an EV');
	process.exit(0);
}

const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
const med = ratios[ratios.length >> 1];
const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
console.log(`\n${rows.length} paired observations`);
console.log(`  ratio: min ${ratios[0].toFixed(2)}x  median ${med.toFixed(2)}x  mean ${mean.toFixed(2)}x  max ${ratios[ratios.length - 1].toFixed(2)}x`);

// Does the premium grow with age? Fit log(ratio) = a + b*age by least squares.
const n = rows.length;
const mx = rows.reduce((a, r) => a + r.age, 0) / n;
const my = rows.reduce((a, r) => a + Math.log(r.ratio), 0) / n;
let num = 0, den = 0;
for (const r of rows) {
	num += (r.age - mx) * (Math.log(r.ratio) - my);
	den += (r.age - mx) ** 2;
}
const b = den ? num / den : 0;
const a = my - b * mx;
let ssTot = 0, ssRes = 0;
for (const r of rows) {
	const pred = a + b * r.age;
	ssTot += (Math.log(r.ratio) - my) ** 2;
	ssRes += (Math.log(r.ratio) - pred) ** 2;
}
console.log(`\n  log-linear fit: ratio = ${Math.exp(a).toFixed(3)} * ${Math.exp(b).toFixed(4)}^age   R2=${(1 - ssRes / ssTot).toFixed(3)}`);
for (const age of [20, 25, 30, 33]) {
	console.log(`    predicted premium at ${age}y: ${Math.exp(a + b * age).toFixed(2)}x`);
}

// Group by decade as a sanity check on the fit.
const buckets = {};
for (const r of rows) {
	const d = Math.floor(Number(r.year) / 10) * 10;
	(buckets[d] ??= []).push(r.ratio);
}
console.log('\n  by decade:');
for (const [d, list] of Object.entries(buckets).sort()) {
	list.sort((x, y) => x - y);
	console.log(`    ${d}s: n=${String(list.length).padStart(2)} median ${list[list.length >> 1].toFixed(2)}x`);
}
