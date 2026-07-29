#!/usr/bin/env node
/**
 * Blackjack verification.
 *
 * Blackjack has too large a state space to enumerate the way the slot machine
 * is enumerated, so this does three different things instead:
 *
 *   1. Exhaustively checks hand evaluation over every hand up to 5 cards.
 *   2. Checks the shoe composition and that the shuffle is unbiased.
 *   3. Measures the house edge by simulating basic strategy over many rounds.
 *
 * Run after touching anything in src/lib/blackjack.js.
 */

import { randomInt } from 'node:crypto';
import {
	RANKS, SUITS, DECKS, BET_LEVELS, MIN_BET, MAX_BET, MAX_HANDS, BLACKJACK_PAYOUT,
	buildShoe, makeCard, cardRank, handValue, isPair, settleHand, dealerShouldHit,
	basicStrategy, isValidBet, maxAffordableBet, stepBet, rankValue
} from '../src/lib/blackjack.js';

const problems = [];
const ROUNDS = Number(process.argv[2] || 500_000);

// ── 1. Shoe ────────────────────────────────────────────────────
const shoe = buildShoe();
console.log(`Shoe: ${DECKS} decks = ${shoe.length} cards`);
if (shoe.length !== DECKS * 52) problems.push(`shoe is ${shoe.length} cards, expected ${DECKS * 52}`);
{
	const byRank = {};
	const bySuit = {};
	for (const c of shoe) {
		byRank[cardRank(c)] = (byRank[cardRank(c)] || 0) + 1;
		const s = c.slice(c.indexOf(':') + 1);
		bySuit[s] = (bySuit[s] || 0) + 1;
	}
	for (const r of RANKS) if (byRank[r] !== DECKS * 4) problems.push(`rank ${r}: ${byRank[r]} not ${DECKS * 4}`);
	for (const s of SUITS) if (bySuit[s.id] !== DECKS * 13) problems.push(`suit ${s.id}: ${bySuit[s.id]}`);
	const tens = RANKS.filter((r) => rankValue(r) === 10).length;
	console.log(`  ranks x${DECKS * 4} each, suits x${DECKS * 13} each, ${tens}/13 ranks worth ten`);
}

// ── 2. Hand evaluation, exhaustively to 5 cards ────────────────
{
	let checked = 0;
	const softNeverBusts = [];
	const walk = (hand, start) => {
		if (hand.length >= 2) {
			checked++;
			const v = handValue(hand);

			// Recompute independently: best total <= 21, else minimum total.
			const aces = hand.filter((c) => cardRank(c) === 'A').length;
			let min = 0;
			for (const c of hand) min += cardRank(c) === 'A' ? 1 : rankValue(cardRank(c));
			let best = min;
			for (let up = 1; up <= aces; up++) if (min + up * 10 <= 21) best = min + up * 10;
			const expectBust = min > 21;
			const expectTotal = expectBust ? min : best;

			if (v.total !== expectTotal) problems.push(`handValue ${hand} => ${v.total}, expected ${expectTotal}`);
			if (v.bust !== expectBust) problems.push(`bust flag wrong for ${hand}`);
			if (v.soft !== (!expectBust && best !== min)) problems.push(`soft flag wrong for ${hand}`);
			if (v.blackjack !== (hand.length === 2 && v.total === 21)) problems.push(`blackjack flag wrong for ${hand}`);

			// A soft hand can never bust on the next card.
			if (v.soft && hand.length < 5) {
				for (const r of RANKS) {
					if (handValue([...hand, makeCard(r, 'w')]).bust) softNeverBusts.push(`${hand}+${r}`);
				}
			}
		}
		if (hand.length === 5) return;
		for (let i = start; i < RANKS.length; i++) walk([...hand, makeCard(RANKS[i], 'w')], i);
	};
	walk([], 0);
	console.log(`\nHand evaluation: ${checked.toLocaleString()} distinct hands (2-5 cards) checked exhaustively`);
	if (softNeverBusts.length) problems.push(`soft hand busted on next card: ${softNeverBusts.slice(0, 3).join(', ')}`);
}

// ── 3. Payout rules ────────────────────────────────────────────
{
	const bet = 100;
	const H = (cards, extra = {}) => ({ cards, bet, ...extra });
	const A = makeCard('A', 'w'), K = makeCard('K', 'u'), N9 = makeCard('9', 'b'), N7 = makeCard('7', 'r'), N5 = makeCard('5', 'w');
	const cases = [
		['player blackjack beats 20', H([A, K]), [K, makeCard('10', 'r')], 'blackjack', 150],
		['blackjack pays 3:2', H([A, K]), [N9, N9], 'blackjack', 150],
		['both blackjack pushes', H([A, K]), [A, K], 'push', 0],
		['dealer blackjack beats 20', H([K, makeCard('10', 'b')]), [A, K], 'lose', -100],
		['split 21 is not a blackjack', H([A, K], { fromSplit: true }), [K, N9], 'win', 100],
		['split 21 pushes dealer blackjack? no — dealer BJ wins', H([A, K], { fromSplit: true }), [A, K], 'lose', -100],
		['bust loses even if dealer busts', H([K, N9, N5]), [K, N7, N9], 'lose', -100],
		['dealer bust wins', H([K, N9]), [K, N7, N9], 'win', 100],
		['higher total wins', H([K, N9]), [K, N7], 'win', 100],
		['lower total loses', H([K, N7]), [K, N9], 'lose', -100],
		['equal totals push', H([K, N9]), [K, N9], 'push', 0],
		['doubled bet doubles the swing', H([K, N9, N5], { bet: 200 }), [K, N7], 'lose', -200]
	];
	for (const [name, hand, dealer, outcome, delta] of cases) {
		const r = settleHand(hand, dealer);
		if (r.outcome !== outcome || r.delta !== delta) {
			problems.push(`payout "${name}": got ${r.outcome}/${r.delta}, expected ${outcome}/${delta}`);
		}
	}
	console.log(`Payout rules: ${cases.length} cases checked (blackjack ${BLACKJACK_PAYOUT}:1)`);
}

// ── 4. Dealer policy ───────────────────────────────────────────
{
	const soft17 = [makeCard('A', 'w'), makeCard('6', 'u')];
	const hard16 = [makeCard('10', 'w'), makeCard('6', 'u')];
	const hard17 = [makeCard('10', 'w'), makeCard('7', 'u')];
	if (dealerShouldHit(soft17)) problems.push('dealer hit soft 17 — house rules say stand');
	if (!dealerShouldHit(hard16)) problems.push('dealer stood on 16');
	if (dealerShouldHit(hard17)) problems.push('dealer hit hard 17');
	if (dealerShouldHit([makeCard('K', 'w'), makeCard('K', 'u'), makeCard('K', 'b')])) problems.push('dealer hit a bust hand');
	console.log('Dealer policy: stands on all 17s including soft 17');
}

// ── 5. Shuffle uniformity ──────────────────────────────────────
{
	const N = 20000;
	const firstRank = {};
	for (let i = 0; i < N; i++) {
		const s = buildShoe();
		for (let j = s.length - 1; j > 0; j--) {
			const k = randomInt(j + 1);
			[s[j], s[k]] = [s[k], s[j]];
		}
		const r = cardRank(s[s.length - 1]);
		firstRank[r] = (firstRank[r] || 0) + 1;
	}
	// Every rank is equally likely to be the first card off the shoe.
	const expected = N / RANKS.length;
	let chi = 0;
	for (const r of RANKS) chi += ((firstRank[r] || 0) - expected) ** 2 / expected;
	// 12 degrees of freedom, p=0.001 critical value is 32.9.
	console.log(`\nShuffle: ${N.toLocaleString()} shuffles, chi-square on first card = ${chi.toFixed(2)} (12 df, fail above 32.9)`);
	if (chi > 32.9) problems.push(`shuffle looks biased: chi-square ${chi.toFixed(2)}`);
}

// ── 6. House edge by simulation with basic strategy ────────────
{
	const SHOE = DECKS * 52;
	let shoeCards = [];
	const reshuffleAt = SHOE * 0.25;
	const drawCard = () => {
		if (shoeCards.length < reshuffleAt) {
			shoeCards = buildShoe();
			for (let i = shoeCards.length - 1; i > 0; i--) {
				const j = randomInt(i + 1);
				[shoeCards[i], shoeCards[j]] = [shoeCards[j], shoeCards[i]];
			}
		}
		return shoeCards.pop();
	};

	let wagered = 0;
	let net = 0;
	const tally = { blackjack: 0, win: 0, push: 0, lose: 0 };
	let handsPlayed = 0;
	const bet = 100;

	for (let round = 0; round < ROUNDS; round++) {
		const dealer = [drawCard(), drawCard()];
		let hands = [{ cards: [drawCard(), drawCard()], bet, done: false }];
		wagered += bet;

		const pv = handValue(hands[0].cards);
		if (!pv.blackjack && !handValue(dealer).blackjack) {
			for (let i = 0; i < hands.length; i++) {
				const h = hands[i];
				let guard = 0;
				while (!h.done && guard++ < 25) {
					const v = handValue(h.cards);
					if (v.bust || v.total === 21) break;
					if (h.fromSplitAce && h.cards.length >= 2) break;
					const fresh = h.cards.length === 2 && !h.doubled;
					const move = basicStrategy(h.cards, dealer[0], {
						canDouble: fresh,
						canSplit: fresh && hands.length < MAX_HANDS && isPair(h.cards)
					});
					if (move === 'split') {
						const splittingAces = cardRank(h.cards[0]) === 'A';
						const moved = h.cards.pop();
						h.fromSplit = true;
						h.fromSplitAce = splittingAces;
						const next = { cards: [moved, drawCard()], bet, done: false, fromSplit: true, fromSplitAce: splittingAces };
						h.cards.push(drawCard());
						hands.splice(i + 1, 0, next);
						wagered += bet;
						if (splittingAces) break;
					} else if (move === 'double') {
						wagered += h.bet;
						h.bet *= 2;
						h.doubled = true;
						h.cards.push(drawCard());
						break;
					} else if (move === 'hit') {
						h.cards.push(drawCard());
					} else {
						break;
					}
				}
			}
			if (hands.some((h) => !handValue(h.cards).bust)) {
				while (dealerShouldHit(dealer)) dealer.push(drawCard());
			}
		}

		for (const h of hands) {
			const r = settleHand(h, dealer);
			net += r.delta;
			tally[r.outcome]++;
			handsPlayed++;
		}
	}

	const edge = -net / wagered;
	console.log(`\nHouse edge: ${ROUNDS.toLocaleString()} rounds, ${handsPlayed.toLocaleString()} hands, basic strategy`);
	const pct = (n) => ((n / handsPlayed) * 100).toFixed(2) + '%';
	console.log(`  blackjack ${pct(tally.blackjack)}   win ${pct(tally.win)}   push ${pct(tally.push)}   lose ${pct(tally.lose)}`);
	console.log(`  wagered ${wagered.toLocaleString()}, net ${net.toLocaleString()}`);
	console.log(`  HOUSE EDGE ${(edge * 100).toFixed(3)}%  (player return ${((1 - edge) * 100).toFixed(2)}%)`);

	// Published basic-strategy edge for 6-deck S17 DAS no-surrender is ~0.40-0.55%.
	// Allow a band that is wide enough for simulation noise but tight enough to
	// catch a genuinely broken rule (a wrong payout moves this by whole points).
	if (edge < -0.002 || edge > 0.012) {
		problems.push(`house edge ${(edge * 100).toFixed(3)}% outside the 0-1.2% band expected for these rules`);
	}
	const bjRate = tally.blackjack / handsPlayed;
	if (bjRate < 0.035 || bjRate > 0.055) problems.push(`blackjack rate ${(bjRate * 100).toFixed(2)}% — expected ~4.7%`);
}

// ── 7. Bet validation ──────────────────────────────────────────
for (const b of [0, -100, -1, 1, 24, 1001, 1e9, 25.5, NaN, Infinity, {}, []]) {
	if (isValidBet(b)) problems.push(`invalid bet accepted: ${String(b)}`);
}
for (const b of BET_LEVELS) if (!isValidBet(b)) problems.push(`valid bet rejected: ${b}`);
for (const gold of [0, 1, 24, 25, 999, 1000, 99999]) {
	const m = maxAffordableBet(gold);
	if (m !== null && m > gold) problems.push(`maxAffordableBet(${gold}) unaffordable: ${m}`);
	for (const dir of [-1, 1]) {
		const s = stepBet(100, dir, gold);
		if (gold >= MIN_BET && s > gold) problems.push(`stepBet(${dir}, ${gold}) unaffordable: ${s}`);
	}
}
console.log(`\nBet ladder: ${MIN_BET}-${MAX_BET} (${BET_LEVELS.join(', ')})`);

console.log(problems.length ? `\nFAIL:\n  ${problems.join('\n  ')}` : '\nAll checks passed');
process.exit(problems.length ? 1 : 0);
