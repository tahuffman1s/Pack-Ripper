/**
 * The Mana Machine — a three-reel, three-row, five-payline slot with free spins.
 *
 * Modelled on a real mechanical slot: each reel is a physical STRIP of stops,
 * and the odds come from how many times a symbol appears on that strip, not
 * from a hand-written probability per symbol. Same idea as the print sheets
 * that drive pack collation — the layout is the data, the odds fall out of it.
 *
 * The window shows three stops per reel, so a spin is a 3x3 grid. Five lines
 * are drawn across it. Because the whole grid is determined by the three reel
 * stops, the entire game is still small enough to solve exactly rather than
 * sample: `node scripts/verify-slots.mjs` enumerates all 24^3 = 13,824
 * outcomes, including every payline and the free-spin round.
 *
 * Shared between client and server. There are no secrets here: knowing the
 * strips does not help you, because the spin is rolled server-side and the
 * client is only told where the reels landed.
 */

// ── Bets ───────────────────────────────────────────────────────

/**
 * Per-line bet denominations. A fixed ladder rather than a free-text amount:
 * it makes the stepper unambiguous, and it lets the server validate against an
 * allow-list instead of range-checking arbitrary input.
 */
export const BET_LEVELS = [5, 10, 25, 50, 100, 200];
export const MIN_BET = BET_LEVELS[0];
export const MAX_BET = BET_LEVELS[BET_LEVELS.length - 1];
export const DEFAULT_BET = 25;

/** How many of the five paylines you may play. */
export const LINE_OPTIONS = [1, 3, 5];
export const DEFAULT_LINES = 5;

/** The cheapest spin possible — one line at the smallest stake. */
export const MIN_TOTAL_BET = BET_LEVELS[0] * LINE_OPTIONS[0];

export function isValidBet(bet) {
	return Number.isInteger(bet) && BET_LEVELS.includes(bet);
}
export function isValidLines(lines) {
	return Number.isInteger(lines) && LINE_OPTIONS.includes(lines);
}

/** What a spin actually costs: the per-line bet times the lines played. */
export function totalBet(lineBet, lines) {
	return lineBet * lines;
}

/** Largest per-line bet this balance can cover at the given line count. */
export function maxAffordableBet(gold, lines) {
	let best = null;
	for (const b of BET_LEVELS) if (b * lines <= gold) best = b;
	return best;
}

/** Step the per-line bet up or down, clamped and capped by affordability. */
export function stepBet(bet, dir, gold = Infinity, lines = DEFAULT_LINES) {
	const i = BET_LEVELS.indexOf(bet);
	const next = BET_LEVELS[Math.min(BET_LEVELS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
	if (next * lines > gold) return maxAffordableBet(gold, lines) ?? BET_LEVELS[0];
	return next;
}

// ── Symbols ────────────────────────────────────────────────────

export const SYMBOLS = {
	wild: { id: 'wild', label: 'Bolt', glyph: '⚡', color: '#facc15', text: '#1c1917', wild: true },
	scatter: { id: 'scatter', label: 'Booster', glyph: '📦', color: '#c084fc', text: '#2e1065', scatter: true },
	mythic: { id: 'mythic', label: 'Mythic', glyph: '◆', color: '#f97316', text: '#1c1917' },
	foil: { id: 'foil', label: 'Foil', glyph: '✦', color: '#22d3ee', text: '#083344' },
	w: { id: 'w', label: 'Plains', glyph: '☀', color: '#fdf6d8', text: '#57534e' },
	u: { id: 'u', label: 'Island', glyph: '💧', color: '#a5d8f3', text: '#0c4a6e' },
	b: { id: 'b', label: 'Swamp', glyph: '☠', color: '#b9aeaa', text: '#1c1917' },
	r: { id: 'r', label: 'Mountain', glyph: '🔥', color: '#f4a58a', text: '#7f1d1d' },
	g: { id: 'g', label: 'Forest', glyph: '🌳', color: '#9bd4a5', text: '#14532d' }
};

export const MANA = ['w', 'u', 'b', 'r', 'g'];

const isWild = (s) => SYMBOLS[s]?.wild === true;
const isScatter = (s) => SYMBOLS[s]?.scatter === true;

// ── Reel strips ────────────────────────────────────────────────

/** 24 stops per reel. */
const STRIP_COUNTS = { wild: 1, scatter: 2, mythic: 2, foil: 4, w: 3, u: 3, b: 3, r: 3, g: 3 };

function buildStrip(offset) {
	const buckets = new Map();
	for (const [id, n] of Object.entries(STRIP_COUNTS)) buckets.set(id, Array(n).fill(id));

	// Round-robin interleave so identical symbols are never adjacent — important
	// for the scatter, since two scatters in one three-row window would skew the
	// free-spin trigger rate. No RNG: the strips must be byte-identical on client
	// and server or the animation would land somewhere the server did not say.
	const spread = [];
	const keys = [...buckets.keys()];
	let guard = 0;
	while (spread.length < 24 && guard++ < 1000) {
		for (const k of keys) {
			const b = buckets.get(k);
			if (b.length) spread.push(b.pop());
		}
	}
	const rot = offset % spread.length;
	return [...spread.slice(rot), ...spread.slice(0, rot)];
}

export const REELS = [buildStrip(0), buildStrip(8), buildStrip(16)];
export const STOPS = REELS[0].length;
export const ROWS = 3;

// ── Paylines ───────────────────────────────────────────────────

/**
 * Row index each reel contributes, left to right. Row 0 is the top of the
 * window, which is the stop BEFORE the landed one; row 2 is the stop after it.
 * The renderer draws the strip in this order too, so what is on screen and what
 * the server scored are the same three rows.
 */
export const PAYLINES = [
	{ name: 'Middle', rows: [1, 1, 1] },
	{ name: 'Top', rows: [0, 0, 0] },
	{ name: 'Bottom', rows: [2, 2, 2] },
	{ name: 'Descend', rows: [0, 1, 2] },
	{ name: 'Ascend', rows: [2, 1, 0] }
];

/** Lines are enabled in PAYLINES order, so "1 line" is always the middle row. */
export function activeLines(lines) {
	return PAYLINES.slice(0, lines);
}

/**
 * The 3x3 window from three reel stops.
 * @returns {string[][]} grid[reel][row]
 */
export function gridFor(stops) {
	return stops.map((stop, reel) => {
		const strip = REELS[reel];
		const n = strip.length;
		return [strip[(stop - 1 + n) % n], strip[stop % n], strip[(stop + 1) % n]];
	});
}

// ── Paytable ───────────────────────────────────────────────────

/**
 * Line wins, as a multiplier of the PER-LINE bet.
 * Scatter pays are a multiplier of the TOTAL bet, as is standard — a scatter
 * win does not belong to any one line.
 */
export const PAYTABLE = {
	wild3: { mult: 600, label: 'TRIPLE BOLT' },
	mythic3: { mult: 55, label: 'Triple Mythic' },
	foil3: { mult: 17, label: 'Triple Foil' },
	mana3: { mult: 8, label: 'Three of a colour' },
	rainbow3: { mult: 1, label: 'Three colours' },
	mythic2: { mult: 2, label: 'Two Mythics' },
	foil2: { mult: 1, label: 'Two Foils' }
};
// There is deliberately no "two wilds" line: two wilds plus any third symbol
// always completes a three-of-a-kind, so such a line could never be reached.

/** Three or more Boosters anywhere on the grid. */
export const SCATTER = { need: 3, payMult: 3, freeSpins: 8, label: 'BOOSTER BONUS' };

/**
 * Score a single payline. Wilds substitute for any symbol except the scatter,
 * which only ever pays scattered. Only the best line pays.
 * @param {string[]} line three symbol ids, left to right
 */
export function evaluate(line) {
	const wilds = line.filter(isWild).length;
	const solid = line.filter((s) => !isWild(s));
	const allIdx = [0, 1, 2];
	const none = { key: null, mult: 0, label: '', winning: [] };

	// A scatter on a payline is inert — it pays from the grid, not the line.
	if (line.some(isScatter)) return none;

	if (wilds === 3) return { key: 'wild3', ...PAYTABLE.wild3, winning: allIdx };
	const uniform = solid.every((s) => s === solid[0]);
	if (uniform && solid.length + wilds === 3) {
		const s = solid[0];
		if (s === 'mythic') return { key: 'mythic3', ...PAYTABLE.mythic3, winning: allIdx };
		if (s === 'foil') return { key: 'foil3', ...PAYTABLE.foil3, winning: allIdx };
		if (MANA.includes(s)) return { key: 'mana3', ...PAYTABLE.mana3, winning: allIdx };
	}

	// Three different mana colours — the "rainbow". A wild stands in as a colour
	// you do not have, so one wild plus two distinct colours also pays.
	if (solid.length >= 2 && solid.every((s) => MANA.includes(s)) && new Set(solid).size === solid.length) {
		return { key: 'rainbow3', ...PAYTABLE.rainbow3, winning: allIdx };
	}

	for (const [sym, key] of [
		['mythic', 'mythic2'],
		['foil', 'foil2']
	]) {
		const idx = allIdx.filter((i) => line[i] === sym || isWild(line[i]));
		if (idx.length >= 2 && line.some((s) => s === sym)) {
			return { key, ...PAYTABLE[key], winning: idx.slice(0, 2) };
		}
	}

	return none;
}

/**
 * Score a whole spin.
 * @param {number[]} stops one landed stop per reel
 * @param {number} lines how many paylines are being played
 * @param {number} lineBet gold staked per line
 */
export function evaluateSpin(stops, lines, lineBet) {
	const grid = gridFor(stops);
	const stake = totalBet(lineBet, lines);

	const lineWins = [];
	let win = 0;
	for (const [i, pl] of activeLines(lines).entries()) {
		const symbols = pl.rows.map((row, reel) => grid[reel][row]);
		const r = evaluate(symbols);
		if (r.mult > 0) {
			const amount = r.mult * lineBet;
			win += amount;
			lineWins.push({ line: i, name: pl.name, rows: pl.rows, key: r.key, label: r.label, mult: r.mult, amount });
		}
	}

	// Scatters pay from anywhere on the grid, on total bet, regardless of lines.
	const scatterCells = [];
	for (let reel = 0; reel < grid.length; reel++) {
		for (let row = 0; row < ROWS; row++) {
			if (isScatter(grid[reel][row])) scatterCells.push([reel, row]);
		}
	}
	const scatterHit = scatterCells.length >= SCATTER.need;
	const scatterWin = scatterHit ? SCATTER.payMult * stake : 0;
	win += scatterWin;

	return {
		grid,
		stake,
		win,
		lineWins,
		scatterCells,
		scatterHit,
		scatterWin,
		freeSpins: scatterHit ? SCATTER.freeSpins : 0
	};
}

// ── Exact solver ───────────────────────────────────────────────

/**
 * Exact return to player over every reel-stop combination. No sampling: the
 * strips are small enough to solve outright, so these are the true numbers.
 *
 * Free spins are folded in analytically. A free spin costs nothing and pays at
 * the same rate as a paid one, and cannot retrigger, so the total return is the
 * base return scaled by (1 + P(trigger) x free spins).
 */
export function computeRtp(lines = DEFAULT_LINES) {
	const combos = REELS[0].length * REELS[1].length * REELS[2].length;
	const lineBet = 1;
	const stake = totalBet(lineBet, lines);

	let paid = 0;
	let scatterPaid = 0;
	let triggers = 0;
	let winningSpins = 0;
	const byKey = {};

	for (let a = 0; a < REELS[0].length; a++) {
		for (let b = 0; b < REELS[1].length; b++) {
			for (let c = 0; c < REELS[2].length; c++) {
				const r = evaluateSpin([a, b, c], lines, lineBet);
				paid += r.win - r.scatterWin;
				scatterPaid += r.scatterWin;
				if (r.scatterHit) triggers++;
				if (r.win > 0) winningSpins++;
				for (const lw of r.lineWins) byKey[lw.key] = (byKey[lw.key] || 0) + 1;
			}
		}
	}

	const lineRtp = paid / (combos * stake);
	const scatterRtp = scatterPaid / (combos * stake);
	const baseRtp = lineRtp + scatterRtp;
	const triggerRate = triggers / combos;
	const freeMultiplier = 1 + triggerRate * SCATTER.freeSpins;

	return {
		combos,
		lines,
		lineRtp,
		scatterRtp,
		baseRtp,
		triggerRate,
		freeSpins: SCATTER.freeSpins,
		freeMultiplier,
		rtp: baseRtp * freeMultiplier,
		hitRate: winningSpins / combos,
		byKey
	};
}
