/**
 * The Mana Machine — a five-reel, three-row, nine-payline slot that pays in gold
 * AND in booster packs.
 *
 * Modelled on a real mechanical slot: each reel is a physical STRIP of stops,
 * and the odds come from how many times a symbol appears on that strip, not
 * from a hand-written probability per symbol. Same idea as the print sheets
 * that drive pack collation — the layout is the data, the odds fall out of it.
 *
 * The window shows three stops per reel, so a spin is a 5x3 grid. Nine lines are
 * drawn across it and pay left to right, two of a kind and up. Because the whole
 * grid is determined by the five reel stops, the entire game is still small
 * enough to solve exactly rather than sample: `node scripts/verify-slots.mjs`
 * enumerates all 24^5 = 7,962,624 outcomes, every payline, the scatter, the
 * free-spin round and the pack prizes.
 *
 * ── Pack prizes ────────────────────────────────────────────────
 *
 * Three Boosters or more pay a booster pack as well as gold. The prize is not a
 * named product but a BUDGET — a multiple of the total bet — and the shop hands
 * over a real pack that costs about that much (see pickPackPrize in
 * server/slots.js). That is what keeps three things true at once:
 *
 *   * Cheap packs are the common prize, expensive packs are rare, and the
 *     vintage grails are the rarest, because the budget tiers are 2x / 12x /
 *     120x the stake and the scatter counts that award them get rarer in step.
 *   * The return stays a pure multiple of the stake, so no bet is better value
 *     than another — an unopened pack sells back for what the shop charges, so a
 *     "budget" of gold and a pack worth that budget are worth the same.
 *   * A budget nothing in the store fits — a 15-gold prize on the smallest
 *     possible spin — is simply paid in gold instead, rather than rounding up to
 *     the cheapest pack on the shelf and quietly inventing return.
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
export const BET_LEVELS = [5, 10, 25, 50, 100, 250, 500, 1000];
export const MIN_BET = BET_LEVELS[0];
export const MAX_BET = BET_LEVELS[BET_LEVELS.length - 1];
/**
 * The default stake is 100 a line — 900 across nine lines — and that is a
 * deliberate choice rather than a middle-of-the-ladder shrug. A pack prize is a
 * multiple of the stake (see the note at the top of this file), so the stake is
 * what decides whether the shop can find a real pack to hand over: at 900 the
 * three tiers are worth about $9, $90 and $1,350, which is a booster, a chase
 * pack and a vintage grail. Spin for five a line and the small tier is worth 45
 * cents, which buys nothing on the shelf and is paid in gold instead.
 */
export const DEFAULT_BET = 100;

/** How many of the nine paylines you may play. */
export const LINE_OPTIONS = [1, 3, 5, 9];
export const DEFAULT_LINES = 9;

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

/** Symbol ids in a fixed order — the encoding the exact solver indexes on. */
export const SYMBOL_IDS = Object.keys(SYMBOLS);

export const MANA = ['w', 'u', 'b', 'r', 'g'];

const isWild = (s) => SYMBOLS[s]?.wild === true;
const isScatter = (s) => SYMBOLS[s]?.scatter === true;

// ── Reel strips ────────────────────────────────────────────────

/**
 * Every reel carries the same twenty ordinary stops, plus four special ones
 * split between the wild and the scatter — and the split is where the reels
 * differ from each other, deliberately:
 *
 *   scatter 2 2 1 1 1     wild 2 2 3 3 3
 *
 * Boosters lean LEFT and wilds lean RIGHT, and both for the same reason: lines
 * pay left to right. A wild late in a line is what turns a three of a kind into a
 * four or a five, so wilds are worth most on the reels that extend a win; a
 * Booster prize is counted across the whole grid, and thinning the Boosters on the
 * right is what makes the five-Booster jackpot need all five reels to cooperate
 * (1 in 8,192) while three of them turn up about once in thirty spins.
 */
const ORDINARY = { mythic: 2, foil: 3, w: 3, u: 3, b: 3, r: 3, g: 3 };
const SCATTERS_PER_REEL = [2, 2, 1, 1, 1];
const WILDS_PER_REEL = [2, 2, 3, 3, 3];

/** 24 stops per reel. */
export const STOPS = 24;

function buildStrip(reel) {
	const buckets = new Map();
	for (const [id, n] of Object.entries(ORDINARY)) buckets.set(id, Array(n).fill(id));
	buckets.set('wild', Array(WILDS_PER_REEL[reel]).fill('wild'));
	buckets.set('scatter', Array(SCATTERS_PER_REEL[reel]).fill('scatter'));

	// Round-robin interleave so identical symbols are never adjacent — important
	// for the scatter, since two scatters in one three-row window would let a
	// single reel contribute twice to a prize the strip counts say it cannot. No
	// RNG: the strips must be byte-identical on client and server or the animation
	// would land somewhere the server did not say.
	const spread = [];
	const keys = [...buckets.keys()];
	let guard = 0;
	while (spread.length < STOPS && guard++ < 1000) {
		for (const k of keys) {
			const bucket = buckets.get(k);
			if (bucket.length) spread.push(bucket.pop());
		}
	}
	// Rotated by a different amount per reel so the five strips do not read as the
	// same sequence stepped sideways.
	const rot = (reel * 7) % spread.length;
	return [...spread.slice(rot), ...spread.slice(0, rot)];
}

export const REELS = [0, 1, 2, 3, 4].map(buildStrip);
export const NREELS = REELS.length;
export const ROWS = 3;

// ── Paylines ───────────────────────────────────────────────────

/**
 * Row index each reel contributes, left to right. Row 0 is the top of the
 * window, which is the stop BEFORE the landed one; row 2 is the stop after it.
 * The renderer draws the strip in this order too, so what is on screen and what
 * the server scored are the same three rows.
 *
 * The order matters twice over. Lines are enabled from the top of this list, so
 * "1 line" is the middle row and "5 lines" is the three straights plus the two
 * full diagonals — the same five shapes the three-reel machine had.
 *
 * And the full nine are chosen so that the pairs (reel 1 row, reel 2 row) they
 * use are ALL NINE distinct combinations. That is not decoration: every win
 * starts with the first two reels matching, and the window only offers three
 * cells on each of them, so nine lines drawn carelessly would ask the same
 * question two or three times over. Covering all nine pairs is what takes the hit
 * rate from around 60% of spins to around 85% — it is the single most effective
 * thing in the whole paytable, and it costs nothing, because every payline has
 * the same expected value whatever shape it is.
 */
export const PAYLINES = [
	{ name: 'Middle', rows: [1, 1, 1, 1, 1] }, // 1,1
	{ name: 'Top', rows: [0, 0, 0, 0, 0] }, // 0,0
	{ name: 'Bottom', rows: [2, 2, 2, 2, 2] }, // 2,2
	{ name: 'Valley', rows: [0, 1, 2, 1, 0] }, // 0,1
	{ name: 'Peak', rows: [2, 1, 0, 1, 2] }, // 2,1
	{ name: 'Dip', rows: [1, 0, 0, 0, 1] }, // 1,0
	{ name: 'Arch', rows: [1, 2, 2, 2, 1] }, // 1,2
	{ name: 'Bolt', rows: [0, 2, 0, 2, 0] }, // 0,2
	{ name: 'Fork', rows: [2, 0, 2, 0, 2] } // 2,0
];

/** Lines are enabled in PAYLINES order, so "1 line" is always the middle row. */
export function activeLines(lines) {
	return PAYLINES.slice(0, lines);
}

/**
 * The 5x3 window from five reel stops.
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
 * Line wins as a multiplier of the PER-LINE bet, by how many of the symbol the
 * line starts with. Wins are left to right and only the best one on a line pays.
 *
 * Two of a kind pays on every symbol, and that is what makes this machine land
 * something on five spins in six. It pays ONE times the LINE bet, which on nine
 * lines is a ninth of what the spin cost — a win the machine announces and a loss
 * the balance records. That is unavoidable at this frequency (paying the stake
 * back that often would mean an RTP well over 100%), so the tuning target is a
 * second figure alongside it: how often a spin returns AT LEAST the stake, which
 * `solve()` counts exactly and verify-slots.mjs prints.
 *
 * The shape below is chosen for that second figure. Three Foils pays 9x and three
 * Mythics 12x, which on the default nine lines is a spin that has paid for
 * itself, and both are cheap to offer because they are far rarer than a colour
 * pair. The bill is settled at the top of the ladder — five of a colour is 16x
 * rather than 40x — which costs almost nothing in felt generosity and buys 4
 * percentage points on the pays-for-itself rate.
 */
export const PAYS = {
	wild: { 2: 2, 3: 30, 4: 180, 5: 1800 },
	mythic: { 2: 1, 3: 12, 4: 35, 5: 180 },
	foil: { 2: 1, 3: 9, 4: 18, 5: 60 },
	mana: { 2: 1, 3: 2, 4: 4, 5: 16 }
};

const CLASS_LABEL = { wild: 'Bolt', mythic: 'Mythic', foil: 'Foil', mana: 'colour' };

/** Flat `wild5`-style table, for the paytable UI and the verifier's per-line audit. */
export const PAYTABLE = (() => {
	const out = {};
	for (const [cls, byRun] of Object.entries(PAYS)) {
		for (const run of [5, 4, 3, 2]) {
			out[`${cls}${run}`] = {
				mult: byRun[run],
				cls,
				run,
				label: run === 5 && cls === 'wild' ? 'FIVE BOLTS' : `${run}× ${CLASS_LABEL[cls]}`
			};
		}
	}
	return out;
})();

/**
 * Booster prizes, by how many Boosters landed anywhere on the grid.
 *
 *   payMult   gold, as a multiple of the TOTAL bet — a scatter win belongs to
 *             the whole grid rather than to any one line, which is standard.
 *   packMult  the pack prize's BUDGET, also as a multiple of the total bet. See
 *             the note at the top of this file for why a budget and not a named
 *             product.
 *   freeSpins awarded on a paid spin only; a free spin cannot retrigger.
 */
export const SCATTER_NEED = 3;
export const SCATTER_TIERS = {
	3: { payMult: 1, packMult: 1, freeSpins: 4, tier: 'booster', label: 'BOOSTER BONUS' },
	4: { payMult: 6, packMult: 10, freeSpins: 8, tier: 'crate', label: 'BOOSTER CRATE' },
	5: { payMult: 50, packMult: 150, freeSpins: 15, tier: 'vault', label: 'BOOSTER VAULT' }
};

/** Human names for the three prize tiers, for the paytable and the win banner. */
export const PACK_TIERS = {
	booster: { label: 'Booster pack', blurb: 'a pack worth about your stake' },
	crate: { label: 'Premium pack', blurb: 'a pack worth about ten times your stake' },
	vault: { label: 'Grail pack', blurb: 'a pack worth about 150 times your stake' }
};

export function scatterTier(count) {
	return SCATTER_TIERS[Math.min(5, count)] || null;
}

/**
 * Score a single payline, left to right. Wilds substitute for any symbol except
 * the scatter, which only ever pays scattered.
 *
 * Every symbol class is tried and the best pay wins, which is what makes wild
 * substitution behave the way a player expects: ⚡⚡☀ is a three-of-a-colour
 * (2x) rather than a two-Bolt (2x) only because those happen to tie, and ⚡⚡◆◆
 * is four Mythics (75x) rather than two Bolts (2x).
 *
 * @param {string[]} line five symbol ids, left to right
 */
export function evaluate(line) {
	const none = { key: null, mult: 0, label: '', run: 0, winning: [] };

	/** How many cells from the left are `id`, counting wilds as a match. */
	const runOf = (id, wildsCount) => {
		let n = 0;
		while (n < line.length && (line[n] === id || (wildsCount && isWild(line[n])))) n++;
		return n;
	};

	let best = none;
	const consider = (cls, run) => {
		const mult = PAYS[cls][run];
		if (!mult || mult <= best.mult) return;
		best = {
			key: `${cls}${run}`,
			mult,
			label: PAYTABLE[`${cls}${run}`].label,
			run,
			winning: Array.from({ length: run }, (_, i) => i)
		};
	};

	// A pure run of wilds, then each real symbol with wilds standing in for it.
	consider('wild', runOf('wild', false));
	consider('mythic', runOf('mythic', true));
	consider('foil', runOf('foil', true));
	for (const c of MANA) consider('mana', runOf(c, true));

	return best;
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
			lineWins.push({
				line: i,
				name: pl.name,
				// Only the cells that actually paid light up, so a two of a kind does
				// not draw a line across all five reels.
				rows: pl.rows.slice(0, r.run),
				fullRows: pl.rows,
				key: r.key,
				label: r.label,
				mult: r.mult,
				amount
			});
		}
	}
	// Biggest line first, so the banner headlines the win worth shouting about.
	lineWins.sort((a, b) => b.amount - a.amount);

	// Scatters pay from anywhere on the grid, on total bet, regardless of lines.
	const scatterCells = [];
	for (let reel = 0; reel < grid.length; reel++) {
		for (let row = 0; row < ROWS; row++) {
			if (isScatter(grid[reel][row])) scatterCells.push([reel, row]);
		}
	}
	const tier = scatterCells.length >= SCATTER_NEED ? scatterTier(scatterCells.length) : null;
	const scatterWin = tier ? tier.payMult * stake : 0;
	win += scatterWin;

	return {
		grid,
		stake,
		win,
		lineWins,
		scatterCells,
		scatterHit: !!tier,
		scatterWin,
		scatterLabel: tier?.label ?? '',
		freeSpins: tier?.freeSpins ?? 0,
		// The pack prize as a budget in gold. The server turns it into a real pack,
		// or pays it as gold when nothing in the store fits.
		packTier: tier?.tier ?? null,
		packBudget: tier ? tier.packMult * stake : 0
	};
}

// ── Exact solver ───────────────────────────────────────────────

/**
 * Exact return over every reel-stop combination. No sampling: 24^5 is under eight
 * million, which is small enough to solve outright, so these are the true numbers.
 *
 * The enumeration is the naive one made cheap. A payline's pay depends only on
 * its five symbols, so every possible line is scored ONCE up front into a table
 * indexed by the five symbols in base 9 (9^5 = 59,049 entries). After that a
 * payline costs one array read, and the five nested loops accumulate the base-9
 * index reel by reel so the innermost loop only adds its own reel's term.
 *
 * Every line count is solved in the same pass, because the interesting assertion
 * is that they agree: scatter and pack prizes pay on the total bet and every
 * payline sees the same symbol distribution (as `stop` sweeps a strip, each row
 * of the window is uniform over it), so lines must buy coverage and not value.
 *
 * Free spins are folded in analytically. A free spin costs nothing, pays at the
 * same rate as a paid one — gold, scatter and packs alike — and cannot retrigger,
 * so the total return is the base return times (1 + expected free spins awarded).
 */
let solved = null;

export function solve() {
	if (solved) return solved;

	const code = new Map(SYMBOL_IDS.map((id, i) => [id, i]));
	const S = SYMBOL_IDS.length; // 9
	const POW = [1, S, S * S, S ** 3, S ** 4];

	// Every possible five-symbol line, scored once.
	const combosPerLine = S ** NREELS;
	const linePay = new Float64Array(combosPerLine);
	const lineKey = new Int16Array(combosPerLine).fill(-1);
	const keyList = Object.keys(PAYTABLE);
	const keyIndex = new Map(keyList.map((k, i) => [k, i]));
	{
		const line = new Array(NREELS);
		const rec = (reel, idx) => {
			if (reel === NREELS) {
				const r = evaluate(line);
				linePay[idx] = r.mult;
				if (r.mult > 0) lineKey[idx] = keyIndex.get(r.key);
				return;
			}
			for (let s = 0; s < S; s++) {
				line[reel] = SYMBOL_IDS[s];
				rec(reel + 1, idx + s * POW[reel]);
			}
		};
		rec(0, 0);
	}

	// Per reel and stop: the base-9 contribution for each payline, and whether the
	// window holds a Booster. One scatter at most per window — the interleave in
	// buildStrip guarantees it, and verify-slots.mjs checks that it still does.
	const nLines = PAYLINES.length;
	const contrib = REELS.map((strip, reel) => {
		const table = new Int32Array(STOPS * nLines);
		for (let stop = 0; stop < STOPS; stop++) {
			for (let p = 0; p < nLines; p++) {
				const row = PAYLINES[p].rows[reel];
				const sym = strip[(stop + row - 1 + STOPS) % STOPS];
				table[stop * nLines + p] = code.get(sym) * POW[reel];
			}
		}
		return table;
	});
	const scatterAt = REELS.map((strip) => {
		const table = new Uint8Array(STOPS);
		for (let stop = 0; stop < STOPS; stop++) {
			let n = 0;
			for (let row = 0; row < ROWS; row++) {
				if (strip[(stop + row - 1 + STOPS) % STOPS] === 'scatter') n++;
			}
			table[stop] = n;
		}
		return table;
	});

	// Accumulators. `perLine` is the summed multiplier each payline paid over the
	// whole enumeration, so any prefix of it is the line return at that line count.
	const perLine = new Float64Array(nLines);
	const byKeyCount = new Int32Array(keyList.length);
	// firstWinAt[p] counts combinations whose FIRST winning payline is p, so the
	// hit rate at N lines is the sum of the first N entries.
	const firstWinAt = new Int32Array(nLines + 1);
	const scatterCount = new Int32Array(NREELS + 1);

	/**
	 * Spins that paid back AT LEAST the stake, per line count.
	 *
	 * This is the honest "did I win" number and the one worth tuning against. A
	 * two of a kind pays one times the LINE bet, so on nine lines it returns a
	 * ninth of what the spin cost — it is a win the machine announces and a loss
	 * the balance records, and a hit rate built out of those flatters the game.
	 * Counted here rather than estimated, at the cost of one running total.
	 */
	const bigWins = new Int32Array(nLines + 1);
	// p+1 -> is that a line count the player can actually select
	const isOption = new Uint8Array(nLines + 1);
	for (const n of LINE_OPTIONS) isOption[n] = 1;

	const acc = Array.from({ length: NREELS }, () => new Int32Array(nLines));
	let combos = 0;

	for (let s0 = 0; s0 < STOPS; s0++) {
		const c0 = contrib[0];
		for (let p = 0; p < nLines; p++) acc[0][p] = c0[s0 * nLines + p];
		const k0 = scatterAt[0][s0];

		for (let s1 = 0; s1 < STOPS; s1++) {
			const c1 = contrib[1];
			for (let p = 0; p < nLines; p++) acc[1][p] = acc[0][p] + c1[s1 * nLines + p];
			const k1 = k0 + scatterAt[1][s1];

			for (let s2 = 0; s2 < STOPS; s2++) {
				const c2 = contrib[2];
				for (let p = 0; p < nLines; p++) acc[2][p] = acc[1][p] + c2[s2 * nLines + p];
				const k2 = k1 + scatterAt[2][s2];

				for (let s3 = 0; s3 < STOPS; s3++) {
					const c3 = contrib[3];
					for (let p = 0; p < nLines; p++) acc[3][p] = acc[2][p] + c3[s3 * nLines + p];
					const k3 = k2 + scatterAt[3][s3];

					const a3 = acc[3];
					for (let s4 = 0; s4 < STOPS; s4++) {
						const c4 = contrib[4];
						const base = s4 * nLines;
						combos++;
						const scatters = k3 + scatterAt[4][s4];
						scatterCount[scatters]++;
						const scatterMult = SCATTER_TIERS[scatters]?.payMult ?? 0;

						let first = nLines;
						let sum = 0;
						for (let p = 0; p < nLines; p++) {
							const idx = a3[p] + c4[base + p];
							const mult = linePay[idx];
							if (mult > 0) {
								perLine[p] += mult;
								byKeyCount[lineKey[idx]]++;
								sum += mult;
								if (p < first) first = p;
							}
							// At N lines the stake is N line-bets and the scatter pays N x its
							// multiplier, so "won at least the stake" is sum >= N x (1 - scatter).
							const n = p + 1;
							if (isOption[n] && sum + scatterMult * n >= n) bigWins[p]++;
						}
						firstWinAt[first]++;
					}
				}
			}
		}
	}

	// Scatter, pack and free-spin figures are line-count independent: they are all
	// multiples of the total bet, so they divide out of the stake identically.
	let scatterPerSpin = 0;
	let packPerSpin = 0;
	let freeSpinsPerSpin = 0;
	let triggers = 0;
	const scatterProb = {};
	for (let k = SCATTER_NEED; k <= NREELS; k++) {
		const p = scatterCount[k] / combos;
		const tier = SCATTER_TIERS[k];
		scatterProb[k] = p;
		if (!tier) continue;
		scatterPerSpin += p * tier.payMult;
		packPerSpin += p * tier.packMult;
		freeSpinsPerSpin += p * tier.freeSpins;
		triggers += scatterCount[k];
	}

	const byLines = {};
	for (const lines of LINE_OPTIONS) {
		let lineMults = 0;
		let hits = 0;
		for (let p = 0; p < lines; p++) {
			lineMults += perLine[p];
			hits += firstWinAt[p];
		}
		// Per-line multipliers are staked on one line each; the stake is lines x that,
		// so the line return is the mean multiplier divided by the line count.
		const lineRtp = lineMults / (combos * lines);
		const baseRtp = lineRtp + scatterPerSpin + packPerSpin;
		const freeMultiplier = 1 + freeSpinsPerSpin;
		byLines[lines] = {
			combos,
			lines,
			lineRtp,
			scatterRtp: scatterPerSpin,
			packRtp: packPerSpin,
			goldRtp: (lineRtp + scatterPerSpin) * freeMultiplier,
			baseRtp,
			triggerRate: triggers / combos,
			freeSpinsPerSpin,
			freeMultiplier,
			rtp: baseRtp * freeMultiplier,
			// A scatter of three or more is a win in its own right even with no line.
			hitRate: (hits + scatterOnlyHits(hits, combos, triggers)) / combos,
			lineHitRate: hits / combos,
			bigHitRate: bigWins[lines - 1] / combos,
			byKey: Object.fromEntries(keyList.map((k, i) => [k, byKeyCount[i]]))
		};
	}

	solved = { combos, stops: STOPS, reels: NREELS, scatterProb, byLines };
	return solved;
}

/**
 * Scatter wins that no payline had already counted.
 *
 * The exact overlap between "some line paid" and "three Boosters landed" is not
 * tracked — it would need a second flag through the innermost loop for a figure
 * that only decorates a report. It is bounded instead: the true count is between
 * zero and `triggers`, and the estimate below assumes independence, which is
 * within a fraction of a percent at these rates. The RETURN figures above use no
 * approximation of any kind; this is only the "how often does something happen"
 * headline.
 */
function scatterOnlyHits(hits, combos, triggers) {
	return Math.round(triggers * (1 - hits / combos));
}

/** The solved figures for one line count. Memoised — the enumeration runs once. */
export function computeRtp(lines = DEFAULT_LINES) {
	return solve().byLines[lines];
}
