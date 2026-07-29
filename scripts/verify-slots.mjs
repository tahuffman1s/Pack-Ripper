#!/usr/bin/env node
/**
 * Slot machine payout verification.
 *
 * Enumerates all 24^3 reel-stop combinations exactly — no sampling — across
 * every payline, plus the scatter and free-spin round. Run after touching the
 * strips, the paylines or the paytable.
 */

import {
	REELS, STOPS, ROWS, PAYLINES, PAYTABLE, SCATTER,
	BET_LEVELS, LINE_OPTIONS, MIN_BET, MAX_BET, DEFAULT_BET, DEFAULT_LINES,
	computeRtp, evaluate, evaluateSpin, gridFor, totalBet,
	isValidBet, isValidLines, maxAffordableBet, stepBet
} from '../src/lib/slots.js';

const TARGET = [0.9, 0.96]; // generous enough to be fun, still a sink
const problems = [];

console.log(`Reels: ${REELS.length} x ${STOPS} stops, window ${ROWS} rows, ${PAYLINES.length} paylines`);
const counts = {};
for (const s of REELS[0]) counts[s] = (counts[s] || 0) + 1;
console.log(`  strip counts: ${JSON.stringify(counts)}`);
for (const [i, r] of REELS.entries()) console.log(`  reel ${i + 1}: ${r.join(' ')}`);

// Two scatters inside one three-row window would skew the trigger rate.
for (const [i, strip] of REELS.entries()) {
	for (let s = 0; s < strip.length; s++) {
		const win = [strip[(s - 1 + strip.length) % strip.length], strip[s], strip[(s + 1) % strip.length]];
		const n = win.filter((x) => x === 'scatter').length;
		if (n > 1) problems.push(`reel ${i + 1} stop ${s}: ${n} scatters in one window`);
	}
}

const full = computeRtp(DEFAULT_LINES);
console.log(`\nEnumerated ${full.combos.toLocaleString()} combinations (exact, not sampled)\n`);
console.log('  line              mult      hits    contributes');
let check = 0;
for (const [key, def] of Object.entries(PAYTABLE)) {
	const hits = full.byKey[key] || 0;
	const contrib = (hits * def.mult) / (full.combos * totalBet(1, full.lines));
	check += contrib;
	console.log(
		`  ${key.padEnd(16)} ${String(def.mult + 'x').padStart(5)} ${String(hits).padStart(9)} ` +
			`${(contrib * 100).toFixed(2).padStart(13)}%`
	);
}
console.log(`  ${'scatter pay'.padEnd(16)} ${String(SCATTER.payMult + 'x').padStart(5)} ${''.padStart(9)} ${(full.scatterRtp * 100).toFixed(2).padStart(13)}%`);

console.log(`\n  Base return      : ${(full.baseRtp * 100).toFixed(2)}%  (lines ${(full.lineRtp * 100).toFixed(2)}% + scatter ${(full.scatterRtp * 100).toFixed(2)}%)`);
console.log(`  Free spins       : ${SCATTER.freeSpins} on ${SCATTER.need}+ scatters, 1 in ${(1 / full.triggerRate).toFixed(0)} spins (${(full.triggerRate * 100).toFixed(3)}%)`);
console.log(`  Free-spin uplift : x${full.freeMultiplier.toFixed(4)}`);
console.log(`  RETURN TO PLAYER : ${(full.rtp * 100).toFixed(2)}%`);
console.log(`  Hit rate         : ${(full.hitRate * 100).toFixed(2)}%  (1 in ${(1 / full.hitRate).toFixed(1)} spins pays)`);
console.log(`  Bet per line     : ${MIN_BET} - ${MAX_BET}  (${BET_LEVELS.join(', ')})`);
console.log(`  Total bet range  : ${MIN_BET * 1} - ${MAX_BET * PAYLINES.length}  (lines: ${LINE_OPTIONS.join('/')})`);
console.log(`  Top line prize   : ${(PAYTABLE.wild3.mult * MAX_BET).toLocaleString()} gold`);

console.log('\n  RTP by line count (must be identical — lines buy coverage, not value):');
const rtps = [];
for (const n of LINE_OPTIONS) {
	const r = computeRtp(n);
	rtps.push(r.rtp);
	console.log(`    ${n} line${n === 1 ? ' ' : 's'}: ${(r.rtp * 100).toFixed(2)}%   trigger 1 in ${(1 / r.triggerRate).toFixed(0)}   hit ${(r.hitRate * 100).toFixed(2)}%`);
}

// ── Assertions ─────────────────────────────────────────────────

if (Math.abs(check + full.scatterRtp - full.baseRtp) > 1e-9) problems.push('paytable contributions do not sum to the base RTP');
if (full.rtp < TARGET[0] || full.rtp > TARGET[1]) {
	problems.push(`RTP ${(full.rtp * 100).toFixed(2)}% outside target ${TARGET[0] * 100}-${TARGET[1] * 100}%`);
}
if (full.rtp >= 1) problems.push('RTP >= 100% — the machine loses gold indefinitely');

// Scatter pays on total bet, so line count must not change the return.
if (Math.max(...rtps) - Math.min(...rtps) > 1e-9) {
	problems.push(`RTP varies by line count: ${rtps.map((r) => (r * 100).toFixed(3)).join(' / ')}`);
}

for (const key of Object.keys(PAYTABLE)) {
	if (!full.byKey[key]) problems.push(`payline "${key}" is unreachable`);
}
if (!full.triggerRate) problems.push('free spins are unreachable — no combination shows enough scatters');

// The window must be exactly what the 3D reel shows: row 0 is the stop before
// the landed one, row 1 the landed stop, row 2 the stop after.
{
	const g = gridFor([5, 5, 5]);
	for (let reel = 0; reel < 3; reel++) {
		const strip = REELS[reel];
		const want = [strip[4], strip[5], strip[6]];
		if (g[reel].join() !== want.join()) problems.push(`gridFor window wrong on reel ${reel + 1}`);
	}
	const wrap = gridFor([0, 0, 0]);
	for (let reel = 0; reel < 3; reel++) {
		if (wrap[reel][0] !== REELS[reel][STOPS - 1]) problems.push(`gridFor does not wrap on reel ${reel + 1}`);
	}
}

// A scatter sitting on a payline must not pay as a line symbol.
if (evaluate(['scatter', 'scatter', 'scatter']).mult !== 0) problems.push('scatters paid as a payline');
if (evaluate(['wild', 'wild', 'scatter']).mult !== 0) problems.push('wilds completed a scatter line');
if (evaluate(['w', 'u', 'foil']).mult !== 0) problems.push('a non-winning line paid out');

// Payouts must scale exactly linearly with the stake at every denomination and
// line count, so no bet is quietly better value than another.
for (const bet of BET_LEVELS) {
	for (const lines of LINE_OPTIONS) {
		const r = evaluateSpin([0, 0, 0], lines, bet);
		const unit = evaluateSpin([0, 0, 0], lines, 1);
		if (r.stake !== bet * lines) problems.push(`stake wrong at bet ${bet} x ${lines}`);
		if (r.win !== unit.win * bet) problems.push(`win does not scale at bet ${bet} x ${lines}`);
	}
}

// Playing more lines can only ever add wins, never remove them.
for (let a = 0; a < STOPS; a += 3) {
	for (let b = 0; b < STOPS; b += 3) {
		const one = evaluateSpin([a, b, 0], 1, 1);
		const five = evaluateSpin([a, b, 0], 5, 1);
		const oneLine = one.win - one.scatterWin;
		const fiveLines = five.win - five.scatterWin;
		if (fiveLines < oneLine) problems.push(`5 lines paid less than 1 line at stops ${a},${b},0`);
	}
}

// Input validation — the shapes a crafted request would use to mint gold.
for (const b of [0, -100, -1, 1, 4, 201, 1e9, 25.5, NaN, Infinity, null, undefined, '25', {}, []]) {
	if (isValidBet(b)) problems.push(`invalid bet accepted: ${String(b)}`);
}
for (const b of BET_LEVELS) if (!isValidBet(b)) problems.push(`valid bet rejected: ${b}`);
for (const l of [0, -1, 2, 4, 6, 1.5, NaN, null, undefined, '5', {}]) {
	if (isValidLines(l)) problems.push(`invalid line count accepted: ${String(l)}`);
}
for (const l of LINE_OPTIONS) if (!isValidLines(l)) problems.push(`valid line count rejected: ${l}`);

// Affordability helpers must never propose a spin you cannot pay for.
for (const gold of [0, 1, 4, 5, 24, 25, 99, 1000, 5000]) {
	for (const lines of LINE_OPTIONS) {
		const m = maxAffordableBet(gold, lines);
		if (m !== null && m * lines > gold) problems.push(`maxAffordableBet(${gold},${lines}) unaffordable: ${m}`);
		if (gold >= MIN_BET * lines && m === null) problems.push(`maxAffordableBet(${gold},${lines}) found nothing`);
		for (const dir of [-1, 1]) {
			const s = stepBet(DEFAULT_BET, dir, gold, lines);
			if (gold >= MIN_BET * lines && s * lines > gold) {
				problems.push(`stepBet(dir=${dir}, gold=${gold}, lines=${lines}) unaffordable: ${s}`);
			}
		}
	}
}

console.log(problems.length ? `\nFAIL:\n  ${problems.join('\n  ')}` : '\nAll checks passed');
process.exit(problems.length ? 1 : 0);
