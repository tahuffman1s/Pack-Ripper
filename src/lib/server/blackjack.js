/**
 * Blackjack — server side.
 *
 * The shoe lives here and is never sent to the client. Only cards that have
 * actually been dealt are visible, and the dealer's hole card is withheld until
 * it is legitimately turned over, so a tampered client cannot see what is
 * coming or what the dealer is holding.
 *
 * The shuffle is a Fisher-Yates using node:crypto randomInt — unbiased, unlike
 * the sort-by-random trick — and the shoe persists across rounds so the game
 * behaves like a real six-deck table rather than a fresh deck every hand.
 */

import { randomInt } from 'node:crypto';
import { getDb, mutate } from './db.js';
import { newStats } from './auth.js';
import {
	buildShoe,
	handValue,
	legalMoves,
	dealerShouldHit,
	settleHand,
	isPair,
	cardRank,
	isValidBet,
	MAX_HANDS,
	RESHUFFLE_AT,
	DECKS
} from '../blackjack.js';

const SHOE_SIZE = DECKS * 52;

function shuffled() {
	const shoe = buildShoe();
	for (let i = shoe.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[shoe[i], shoe[j]] = [shoe[j], shoe[i]];
	}
	return shoe;
}

/** Draw one card, reshuffling if the shoe is spent. Mutates `state`. */
function draw(state) {
	if (!state.shoe?.length) {
		state.shoe = shuffled();
		state.shuffled = true;
	}
	return state.shoe.pop();
}

function ensureShoe(state) {
	if (!state.shoe || state.shoe.length < SHOE_SIZE * RESHUFFLE_AT) {
		state.shoe = shuffled();
		state.shuffled = true;
	}
}

function tableOf(userId) {
	return getDb().blackjack?.[userId] || null;
}

/**
 * What the client is allowed to see. The shoe is stripped entirely and the
 * dealer's hole card only appears once the round is over.
 */
export function publicView(userId) {
	const t = tableOf(userId);
	if (!t) return null;
	const revealed = t.phase === 'done';
	const dealerCards = revealed ? t.dealer : t.dealer.slice(0, 1);

	return {
		phase: t.phase,
		hands: t.hands.map((h, i) => ({
			cards: h.cards,
			bet: h.bet,
			doubled: !!h.doubled,
			fromSplit: !!h.fromSplit,
			done: !!h.done,
			value: handValue(h.cards),
			active: t.phase === 'player' && i === t.active,
			outcome: h.outcome || null,
			delta: h.delta ?? null,
			moves:
				t.phase === 'player' && i === t.active
					? legalMoves(h, {
							gold: getDb().wallets[userId]?.gold ?? 0,
							canSplitMore: t.hands.length < MAX_HANDS
						})
					: []
		})),
		dealer: dealerCards,
		dealerValue: revealed ? handValue(t.dealer) : handValue(dealerCards),
		dealerHidden: !revealed,
		active: t.active,
		totalDelta: t.totalDelta ?? null,
		shuffled: !!t.shuffled,
		cardsLeft: t.shoe?.length ?? 0,
		penetration: t.shoe ? 1 - t.shoe.length / SHOE_SIZE : 0
	};
}

/** Play the dealer out and settle every hand. Mutates `t`, returns net delta. */
function finish(t, userId, d) {
	// The dealer only draws if at least one hand is still live; with everyone
	// bust or holding a blackjack the extra cards would be pure theatre and
	// would burn shoe position that a counting player could reason about.
	const live = t.hands.some((h) => !handValue(h.cards).bust);
	if (live) {
		while (dealerShouldHit(t.dealer)) t.dealer.push(draw(t));
	}

	let payout = 0;
	let delta = 0;
	for (const h of t.hands) {
		const r = settleHand(h, t.dealer);
		h.outcome = r.outcome;
		h.delta = r.delta;
		payout += r.payout;
		delta += r.delta;
	}
	t.phase = 'done';
	t.totalDelta = delta;

	d.wallets[userId].gold += payout;

	const s = (d.stats[userId] ??= newStats());
	s.bjRounds = (s.bjRounds || 0) + 1;
	s.bjHands = (s.bjHands || 0) + t.hands.length;
	s.bjWagered = (s.bjWagered || 0) + t.hands.reduce((a, h) => a + h.bet, 0);
	s.bjNet = (s.bjNet || 0) + delta;
	if (delta > 0) s.goldEarned += delta;
	for (const h of t.hands) {
		if (h.outcome === 'blackjack') s.bjBlackjacks = (s.bjBlackjacks || 0) + 1;
		else if (h.outcome === 'win') s.bjWins = (s.bjWins || 0) + 1;
		else if (h.outcome === 'push') s.bjPushes = (s.bjPushes || 0) + 1;
		else if (h.outcome === 'lose') s.bjLosses = (s.bjLosses || 0) + 1;
	}
	if (delta > (s.bjBest || 0)) s.bjBest = delta;
	return delta;
}

/** Advance to the next hand that still needs a decision, or run the dealer. */
function advance(t, userId, d) {
	while (t.active < t.hands.length && t.hands[t.active].done) t.active++;
	if (t.active >= t.hands.length) finish(t, userId, d);
}

// ── Actions ────────────────────────────────────────────────────

export function deal(userId, bet) {
	const db = getDb();
	const wallet = db.wallets[userId];
	if (!wallet) return { ok: false, error: 'No wallet.' };
	if (!isValidBet(bet)) return { ok: false, error: 'Invalid bet.' };

	const existing = tableOf(userId);
	if (existing && existing.phase !== 'done') {
		return { ok: false, error: 'Finish the hand you are playing.' };
	}
	if (wallet.gold < bet) return { ok: false, error: `You need ${bet} gold for that bet.` };

	mutate((d) => {
		const prev = d.blackjack?.[userId];
		const t = {
			shoe: prev?.shoe ?? null,
			shuffled: false,
			phase: 'player',
			dealer: [],
			hands: [{ cards: [], bet, done: false }],
			active: 0,
			totalDelta: null,
			bet
		};
		ensureShoe(t);

		d.wallets[userId].gold -= bet;
		const s = (d.stats[userId] ??= newStats());
		s.goldSpent += bet;

		// Deal in the real order: player, dealer, player, dealer-hole.
		t.hands[0].cards.push(draw(t));
		t.dealer.push(draw(t));
		t.hands[0].cards.push(draw(t));
		t.dealer.push(draw(t));

		// The dealer peeks at a blackjack immediately; there is nothing for the
		// player to decide if the round is already over.
		const pv = handValue(t.hands[0].cards);
		const dv = handValue(t.dealer);
		if (pv.blackjack || dv.blackjack) {
			t.hands[0].done = true;
			finish(t, userId, d);
		}

		(d.blackjack ??= {})[userId] = t;
	});

	return { ok: true, table: publicView(userId), gold: getDb().wallets[userId].gold };
}

export function act(userId, action) {
	const db = getDb();
	const t = tableOf(userId);
	if (!t) return { ok: false, error: 'No hand in play.' };
	if (t.phase !== 'player') return { ok: false, error: 'The hand is already finished.' };

	const hand = t.hands[t.active];
	if (!hand) return { ok: false, error: 'No active hand.' };

	const allowed = legalMoves(hand, {
		gold: db.wallets[userId]?.gold ?? 0,
		canSplitMore: t.hands.length < MAX_HANDS
	});
	if (!allowed.includes(action)) return { ok: false, error: `You cannot ${action} right now.` };

	mutate((d) => {
		const table = d.blackjack[userId];
		table.shuffled = false;
		const h = table.hands[table.active];

		if (action === 'hit') {
			h.cards.push(draw(table));
			const v = handValue(h.cards);
			if (v.bust || v.total === 21) h.done = true;
		} else if (action === 'stand') {
			h.done = true;
		} else if (action === 'double') {
			d.wallets[userId].gold -= h.bet;
			(d.stats[userId] ??= newStats()).goldSpent += h.bet;
			h.bet *= 2;
			h.doubled = true;
			h.cards.push(draw(table));
			h.done = true;
		} else if (action === 'split') {
			d.wallets[userId].gold -= h.bet;
			(d.stats[userId] ??= newStats()).goldSpent += h.bet;
			const moved = h.cards.pop();
			const splittingAces = cardRank(h.cards[0]) === 'A';
			h.fromSplit = true;
			h.fromSplitAce = splittingAces;
			const next = {
				cards: [moved],
				bet: h.bet,
				done: false,
				fromSplit: true,
				fromSplitAce: splittingAces
			};
			// Each new hand is dealt back up to two cards straight away.
			h.cards.push(draw(table));
			next.cards.push(draw(table));
			table.hands.splice(table.active + 1, 0, next);
			// Split aces get exactly one card each and then stand.
			if (splittingAces) {
				h.done = true;
				next.done = true;
			} else {
				if (handValue(h.cards).total === 21) h.done = true;
			}
		}

		advance(table, userId, d);
	});

	return { ok: true, table: publicView(userId), gold: getDb().wallets[userId].gold };
}

/** Suggested play, from the same basic-strategy table the verifier measures. */
export function hint(userId) {
	const t = tableOf(userId);
	if (!t || t.phase !== 'player') return null;
	const h = t.hands[t.active];
	if (!h) return null;
	const allowed = legalMoves(h, {
		gold: getDb().wallets[userId]?.gold ?? 0,
		canSplitMore: t.hands.length < MAX_HANDS
	});
	return { allowed, hand: h.cards, dealerUp: t.dealer[0] };
}

export function blackjackStats(userId) {
	const s = getDb().stats[userId] || {};
	const wagered = s.bjWagered || 0;
	return {
		rounds: s.bjRounds || 0,
		hands: s.bjHands || 0,
		wagered,
		net: s.bjNet || 0,
		edge: wagered > 0 ? -(s.bjNet || 0) / wagered : null,
		blackjacks: s.bjBlackjacks || 0,
		wins: s.bjWins || 0,
		pushes: s.bjPushes || 0,
		losses: s.bjLosses || 0,
		best: s.bjBest || 0
	};
}
