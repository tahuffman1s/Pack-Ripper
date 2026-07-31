#!/usr/bin/env node
/**
 * Slot machine payout verification.
 *
 * Enumerates all 24^5 = 7,962,624 reel-stop combinations exactly — no sampling —
 * across every payline, plus the scatter, the free-spin round and the pack prizes.
 * Run after touching the strips, the paylines or the paytable.
 *
 * Two return figures are reported and both matter. GOLD is what the machine pays
 * in coin; TOTAL adds the pack prizes, which are budgets expressed as a multiple
 * of the stake and are therefore exactly as computable as the coin (see the note at
 * the top of lib/slots.js for why a pack prize is worth precisely its budget).
 * TOTAL is the number a player experiences, so TOTAL is what has to stay under 100%.
 */

import {
	REELS, NREELS, STOPS, ROWS, PAYLINES, PAYS, PAYTABLE,
	SCATTER_NEED, SCATTER_TIERS, PACK_TIERS, MANA, SYMBOLS,
	BET_LEVELS, LINE_OPTIONS, MIN_BET, MAX_BET, DEFAULT_BET, DEFAULT_LINES,
	solve, computeRtp, evaluate, evaluateSpin, gridFor, totalBet,
	isValidBet, isValidLines, maxAffordableBet, stepBet
} from '../src/lib/slots.js';

const TARGET = [0.9, 0.97]; // generous enough to be fun, still a sink
const problems = [];

console.log(`Reels: ${NREELS} x ${STOPS} stops, window ${ROWS} rows, ${PAYLINES.length} paylines`);
for (const [i, r] of REELS.entries()) {
	const counts = {};
	for (const s of r) counts[s] = (counts[s] || 0) + 1;
	if (r.length !== STOPS) problems.push(`reel ${i + 1} has ${r.length} stops, not ${STOPS}`);
	console.log(`  reel ${i + 1}: wild ${counts.wild} scatter ${counts.scatter} — ${r.join(' ')}`);
}

// Two scatters inside one three-row window would let one reel contribute twice to
// a prize the strip counts say it cannot.
for (const [i, strip] of REELS.entries()) {
	for (let s = 0; s < strip.length; s++) {
		const win = [strip[(s - 1 + strip.length) % strip.length], strip[s], strip[(s + 1) % strip.length]];
		const n = win.filter((x) => x === 'scatter').length;
		if (n > 1) problems.push(`reel ${i + 1} stop ${s}: ${n} scatters in one window`);
	}
}

/**
 * Every payline must ask a DIFFERENT question of the first two reels.
 *
 * A win starts with reels one and two matching, and the window offers three cells
 * on each, so there are exactly nine distinct openings. Nine paylines that reuse an
 * opening are nine paylines doing the work of seven — it cost 20 percentage points
 * of hit rate when they did, which is why this is an assertion and not a comment.
 */
{
	const openings = new Set(PAYLINES.map((pl) => `${pl.rows[0]},${pl.rows[1]}`));
	console.log(`\n  distinct (reel 1, reel 2) openings: ${openings.size} of ${PAYLINES.length} lines`);
	if (openings.size !== PAYLINES.length) {
		problems.push(
			`only ${openings.size} distinct openings across ${PAYLINES.length} paylines — ` +
				'lines are duplicating each other'
		);
	}
}

const t0 = Date.now();
const all = solve();
const full = all.byLines[DEFAULT_LINES];
console.log(`\nEnumerated ${full.combos.toLocaleString()} combinations exactly in ${Date.now() - t0}ms\n`);

console.log('  line              mult       hits    contributes');
let check = 0;
for (const [key, def] of Object.entries(PAYTABLE)) {
	const hits = full.byKey[key] || 0;
	const contrib = (hits * def.mult) / (full.combos * full.lines);
	check += contrib;
	console.log(
		`  ${key.padEnd(16)} ${String(def.mult + 'x').padStart(6)} ${String(hits).padStart(10)} ` +
			`${(contrib * 100).toFixed(2).padStart(12)}%`
	);
}
console.log(`  ${'scatter gold'.padEnd(16)} ${''.padStart(6)} ${''.padStart(10)} ${(full.scatterRtp * 100).toFixed(2).padStart(12)}%`);
console.log(`  ${'pack prizes'.padEnd(16)} ${''.padStart(6)} ${''.padStart(10)} ${(full.packRtp * 100).toFixed(2).padStart(12)}%`);

console.log('\n  Booster prizes:');
for (let k = SCATTER_NEED; k <= NREELS; k++) {
	const tier = SCATTER_TIERS[k];
	const p = all.scatterProb[k];
	if (!tier) continue;
	console.log(
		`    ${k} Boosters  1 in ${String(Math.round(1 / p)).padStart(6)}  ` +
			`${tier.payMult}x gold + ${tier.packMult}x as a pack + ${tier.freeSpins} free spins  ` +
			`(${PACK_TIERS[tier.tier].label})`
	);
}

console.log(`\n  Line return      : ${(full.lineRtp * 100).toFixed(2)}%`);
console.log(`  Scatter gold     : ${(full.scatterRtp * 100).toFixed(2)}%`);
console.log(`  Pack prizes      : ${(full.packRtp * 100).toFixed(2)}%`);
console.log(`  Free spins       : 1 in ${(1 / full.triggerRate).toFixed(0)} spins, ${full.freeSpinsPerSpin.toFixed(3)} awarded per paid spin -> x${full.freeMultiplier.toFixed(4)}`);
console.log(`  RETURN, GOLD     : ${(full.goldRtp * 100).toFixed(2)}%`);
console.log(`  RETURN, TOTAL    : ${(full.rtp * 100).toFixed(2)}%   <- gold + packs`);
console.log(`  Hit rate         : ${(full.hitRate * 100).toFixed(2)}%  (1 in ${(1 / full.hitRate).toFixed(2)} spins pays something)`);
console.log(`  Pays for itself  : ${(full.bigHitRate * 100).toFixed(2)}%  (won at least the stake)`);
console.log(`  Bet per line     : ${MIN_BET} - ${MAX_BET}  (${BET_LEVELS.join(', ')})`);
console.log(`  Total bet range  : ${MIN_BET * LINE_OPTIONS[0]} - ${MAX_BET * PAYLINES.length}  (lines: ${LINE_OPTIONS.join('/')})`);
console.log(`  Top line prize   : ${(PAYTABLE.wild5.mult * MAX_BET).toLocaleString()} gold`);
console.log(`  Grail pack budget: ${(SCATTER_TIERS[5].packMult * MAX_BET * PAYLINES.length).toLocaleString()} gold at the top of the ladder`);

console.log('\n  By line count (return must be identical — lines buy coverage, not value):');
const rtps = [];
for (const n of LINE_OPTIONS) {
	const r = all.byLines[n];
	rtps.push(r.rtp);
	console.log(
		`    ${String(n).padStart(2)} line${n === 1 ? ' ' : 's'}: return ${(r.rtp * 100).toFixed(2)}%   ` +
			`hit ${(r.hitRate * 100).toFixed(2)}%   pays for itself ${(r.bigHitRate * 100).toFixed(2)}%`
	);
}

// ── Assertions ─────────────────────────────────────────────────

if (Math.abs(check - full.lineRtp) > 1e-9) {
	problems.push(`paytable contributions (${check}) do not sum to the line return (${full.lineRtp})`);
}
if (Math.abs(full.lineRtp + full.scatterRtp + full.packRtp - full.baseRtp) > 1e-9) {
	problems.push('line + scatter + pack does not sum to the base return');
}
if (full.rtp < TARGET[0] || full.rtp > TARGET[1]) {
	problems.push(`total return ${(full.rtp * 100).toFixed(2)}% outside target ${TARGET[0] * 100}-${TARGET[1] * 100}%`);
}
if (full.rtp >= 1) problems.push('return >= 100% — the machine loses gold indefinitely');
if (full.packRtp <= 0) problems.push('pack prizes contribute nothing — the machine never pays a pack');

// The whole point of the retune: the machine has to land something more often than
// the three-reel version it replaced, which paid on 81.55% of five-line spins.
if (full.hitRate < 0.8155) {
	problems.push(`hit rate ${(full.hitRate * 100).toFixed(2)}% is below the 81.55% the three-reel machine managed`);
}

// Scatter and pack prizes pay on total bet, and every payline sees the same symbol
// distribution, so line count must not change the return.
if (Math.max(...rtps) - Math.min(...rtps) > 1e-9) {
	problems.push(`return varies by line count: ${rtps.map((r) => (r * 100).toFixed(3)).join(' / ')}`);
}

for (const key of Object.keys(PAYTABLE)) {
	if (!full.byKey[key]) problems.push(`payline "${key}" is unreachable`);
}
if (!full.triggerRate) problems.push('free spins are unreachable — no combination shows enough scatters');
for (let k = SCATTER_NEED; k <= NREELS; k++) {
	if (!all.scatterProb[k]) problems.push(`${k} scatters is unreachable`);
}

// The prize ladder has to actually be a ladder: rarer must mean better, or the
// "low value common, grail rarest" shape the game promises is not what it does.
for (let k = SCATTER_NEED; k < NREELS; k++) {
	const lo = SCATTER_TIERS[k];
	const hi = SCATTER_TIERS[k + 1];
	if (!lo || !hi) continue;
	if (all.scatterProb[k + 1] >= all.scatterProb[k]) {
		problems.push(`${k + 1} scatters is not rarer than ${k}`);
	}
	if (hi.packMult <= lo.packMult) problems.push(`${k + 1} scatters does not pay a better pack than ${k}`);
	if (hi.payMult <= lo.payMult) problems.push(`${k + 1} scatters does not pay more gold than ${k}`);
}

// The window must be exactly what the reel shows: row 0 is the stop before the
// landed one, row 1 the landed stop, row 2 the stop after.
{
	const g = gridFor(Array(NREELS).fill(5));
	for (let reel = 0; reel < NREELS; reel++) {
		const strip = REELS[reel];
		const want = [strip[4], strip[5], strip[6]];
		if (g[reel].join() !== want.join()) problems.push(`gridFor window wrong on reel ${reel + 1}`);
	}
	const wrap = gridFor(Array(NREELS).fill(0));
	for (let reel = 0; reel < NREELS; reel++) {
		if (wrap[reel][0] !== REELS[reel][STOPS - 1]) problems.push(`gridFor does not wrap on reel ${reel + 1}`);
	}
}

// ── Line scoring ───────────────────────────────────────────────
const line = (...s) => evaluate(s);
const expect = (got, want, what) => {
	if (got !== want) problems.push(`${what}: expected ${want}, got ${got}`);
};

// Wilds substitute for anything except the scatter, and the BEST reading of a line
// is the one that pays.
expect(line('wild', 'wild', 'wild', 'wild', 'wild').mult, PAYS.wild[5], 'five wilds');
expect(line('wild', 'wild', 'mythic', 'mythic', 'x').mult, PAYS.mythic[4], 'two wilds into two mythics');
expect(line('mythic', 'wild', 'mythic', 'foil', 'foil').mult, PAYS.mythic[3], 'wild inside a mythic run');
expect(line('w', 'w', 'w', 'w', 'w').mult, PAYS.mana[5], 'five of a colour');
expect(line('w', 'u', 'b', 'r', 'g').mult, 0, 'five different colours');
expect(line('foil', 'w', 'w', 'w', 'w').mult, PAYS.foil[2] > PAYS.mana[4] ? PAYS.foil[2] : 0, 'a run that does not start where the pay is');

// A scatter is inert on a payline — it pays from the grid, not the line — and a
// wild must not complete a scatter run.
expect(line('scatter', 'scatter', 'scatter', 'scatter', 'scatter').mult, 0, 'scatters on a payline');
expect(line('wild', 'wild', 'scatter', 'x', 'x').mult, PAYS.wild[2], 'wilds up to a scatter');
if (line('scatter', 'wild', 'wild', 'wild', 'wild').mult !== 0) {
	problems.push('a scatter in the first cell still paid as a line');
}

// Runs are left to right only.
expect(line('x', 'mythic', 'mythic', 'mythic', 'mythic').mult, 0, 'a four-run that does not touch reel 1');

// Only the cells that paid are marked as winning, so the overlay does not draw a
// line across reels that had nothing to do with it.
{
	const r = line('mythic', 'mythic', 'x', 'x', 'x');
	if (r.winning.length !== 2) problems.push(`a two of a kind marked ${r.winning.length} cells`);
	const five = line('wild', 'wild', 'wild', 'wild', 'wild');
	if (five.winning.length !== 5) problems.push(`five of a kind marked ${five.winning.length} cells`);
}

// Every symbol class must be payable, or a symbol on the strips is decoration.
for (const cls of Object.keys(PAYS)) {
	const id = cls === 'mana' ? MANA[0] : cls;
	const r = evaluate(Array(5).fill(id));
	if (r.mult !== PAYS[cls][5]) problems.push(`five ${id} did not pay ${cls}5`);
}
// And every symbol on a strip must be one the evaluator knows about.
for (const [i, strip] of REELS.entries()) {
	for (const s of strip) if (!SYMBOLS[s]) problems.push(`reel ${i + 1} carries unknown symbol "${s}"`);
}

// ── Stake handling ─────────────────────────────────────────────

// Payouts must scale exactly linearly with the stake at every denomination and
// line count, so no bet is quietly better value than another. The pack BUDGET has
// to scale too — it is the other half of the return.
for (const bet of BET_LEVELS) {
	for (const lines of LINE_OPTIONS) {
		const stops = Array(NREELS).fill(0);
		const r = evaluateSpin(stops, lines, bet);
		const unit = evaluateSpin(stops, lines, 1);
		if (r.stake !== bet * lines) problems.push(`stake wrong at bet ${bet} x ${lines}`);
		if (r.win !== unit.win * bet) problems.push(`win does not scale at bet ${bet} x ${lines}`);
		if (r.packBudget !== unit.packBudget * bet) {
			problems.push(`pack budget does not scale at bet ${bet} x ${lines}`);
		}
	}
}

// Playing more lines can only ever add wins, never remove them.
for (let a = 0; a < STOPS; a += 5) {
	for (let b = 0; b < STOPS; b += 5) {
		const stops = [a, b, 0, 0, 0];
		const one = evaluateSpin(stops, 1, 1);
		const nine = evaluateSpin(stops, PAYLINES.length, 1);
		if (nine.win - nine.scatterWin < one.win - one.scatterWin) {
			problems.push(`${PAYLINES.length} lines paid less than 1 line at stops ${stops.join(',')}`);
		}
	}
}

// A pack prize only ever accompanies a scatter win, and every scatter win carries
// one — otherwise the tier table and the payout disagree.
{
	let scatterSpins = 0;
	let withBudget = 0;
	for (let a = 0; a < STOPS; a++) {
		for (let b = 0; b < STOPS; b++) {
			const r = evaluateSpin([a, b, a, b, a], DEFAULT_LINES, DEFAULT_BET);
			if (r.scatterHit) scatterSpins++;
			if (r.packBudget > 0) {
				withBudget++;
				if (!r.scatterHit) problems.push(`a pack budget was awarded without a scatter win`);
				if (!r.packTier) problems.push('a pack budget was awarded with no tier');
			}
		}
	}
	if (scatterSpins !== withBudget) {
		problems.push(`${scatterSpins} scatter wins produced ${withBudget} pack budgets`);
	}
}

// ── Input validation ───────────────────────────────────────────
// The shapes a crafted request would use to mint gold.
for (const b of [0, -100, -1, 1, 4, 26, 999, 1001, 1e9, 25.5, NaN, Infinity, null, undefined, '25', {}, []]) {
	if (isValidBet(b)) problems.push(`invalid bet accepted: ${String(b)}`);
}
for (const b of BET_LEVELS) if (!isValidBet(b)) problems.push(`valid bet rejected: ${b}`);
for (const l of [0, -1, 2, 4, 6, 8, 10, 1.5, NaN, null, undefined, '9', {}]) {
	if (isValidLines(l)) problems.push(`invalid line count accepted: ${String(l)}`);
}
for (const l of LINE_OPTIONS) if (!isValidLines(l)) problems.push(`valid line count rejected: ${l}`);

// Affordability helpers must never propose a spin you cannot pay for.
for (const gold of [0, 1, 4, 5, 44, 45, 99, 900, 5000, 9_000_000]) {
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

// computeRtp is the memoised view onto solve(); the two must not diverge.
for (const n of LINE_OPTIONS) {
	if (computeRtp(n) !== all.byLines[n]) problems.push(`computeRtp(${n}) is not solve().byLines[${n}]`);
}
if (totalBet(DEFAULT_BET, DEFAULT_LINES) !== DEFAULT_BET * DEFAULT_LINES) problems.push('totalBet is wrong');

console.log(problems.length ? `\nFAIL:\n  ${problems.join('\n  ')}` : '\nAll checks passed');
process.exit(problems.length ? 1 : 0);
