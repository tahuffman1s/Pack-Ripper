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
 *
 * The table is one jsonb row per player. finish() and advance() used to be handed
 * the whole database so they could credit a wallet and bump stats in passing; they
 * are now handed a small `ctx` of { gold, stats } that the caller writes back
 * once, at the end of the transaction. Same arithmetic, but the only thing that
 * knows how to persist anything is the action that opened the transaction.
 */

import { randomInt } from 'node:crypto';
import { query, tx, lockGold, setGold, lockStats, writeStats, readStats } from './db.js';
import {
	buildShoe,
	handValue,
	legalMoves,
	dealerShouldHit,
	settleHand,
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

/** Read a table without locking, for display. */
async function tableOf(userId) {
	const { rows } = await query('SELECT state FROM blackjack WHERE user_id = $1', [userId]);
	return rows[0]?.state || null;
}

/** Read a table and hold the row for the rest of the transaction. */
async function lockTable(client, userId) {
	const { rows } = await client.query(
		'SELECT state FROM blackjack WHERE user_id = $1 FOR UPDATE',
		[userId]
	);
	return rows[0]?.state || null;
}

async function writeTable(client, userId, state) {
	await client.query(
		`INSERT INTO blackjack (user_id, state) VALUES ($1, $2::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state`,
		[userId, JSON.stringify(state)]
	);
}

/**
 * What the client is allowed to see. The shoe is stripped entirely and the
 * dealer's hole card only appears once the round is over.
 *
 * Pure: it takes the table and the balance rather than fetching either, so an
 * action can render the state it has just written without reading it back.
 */
function publicView(t, gold) {
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
							gold,
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

/** The table as the page needs it, with the balance the moves are judged against. */
export async function tableState(userId) {
	const [t, { rows }] = await Promise.all([
		tableOf(userId),
		query('SELECT gold FROM wallets WHERE user_id = $1', [userId])
	]);
	return publicView(t, rows[0]?.gold ?? 0);
}

/**
 * Play the dealer out and settle every hand. Mutates `t` and `ctx`, returns net
 * delta.
 */
function finish(t, ctx) {
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

	ctx.gold += payout;

	const s = ctx.stats;
	s.bjRounds = (s.bjRounds || 0) + 1;
	s.bjHands = (s.bjHands || 0) + t.hands.length;
	s.bjWagered = (s.bjWagered || 0) + t.hands.reduce((a, h) => a + h.bet, 0);
	s.bjNet = (s.bjNet || 0) + delta;
	if (delta > 0) s.goldEarned = (s.goldEarned || 0) + delta;
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
function advance(t, ctx) {
	while (t.active < t.hands.length && t.hands[t.active].done) t.active++;
	if (t.active >= t.hands.length) finish(t, ctx);
}

// ── Actions ────────────────────────────────────────────────────

export async function deal(userId, bet) {
	return tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) return { ok: false, error: 'No wallet.' };
		if (!isValidBet(bet)) return { ok: false, error: 'Invalid bet.' };

		const prev = await lockTable(client, userId);
		if (prev && prev.phase !== 'done') {
			return { ok: false, error: 'Finish the hand you are playing.' };
		}
		if (gold < bet) return { ok: false, error: `You need ${bet} gold for that bet.` };

		const t = {
			// The shoe survives the round, which is the point of a six-deck table.
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

		const ctx = { gold, stats: await lockStats(client, userId) };
		ctx.gold -= bet;
		ctx.stats.goldSpent = (ctx.stats.goldSpent || 0) + bet;

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
			finish(t, ctx);
		}

		await writeTable(client, userId, t);
		await setGold(client, userId, ctx.gold);
		await writeStats(client, userId, ctx.stats);

		return { ok: true, table: publicView(t, ctx.gold), gold: ctx.gold };
	});
}

export async function act(userId, action) {
	return tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) return { ok: false, error: 'No wallet.' };

		const t = await lockTable(client, userId);
		if (!t) return { ok: false, error: 'No hand in play.' };
		if (t.phase !== 'player') return { ok: false, error: 'The hand is already finished.' };

		const hand = t.hands[t.active];
		if (!hand) return { ok: false, error: 'No active hand.' };

		// Judged against the locked balance, inside the transaction that will spend
		// it. Two "double" requests fired at once can no longer both be told yes
		// against a balance that only covers one of them.
		const allowed = legalMoves(hand, {
			gold,
			canSplitMore: t.hands.length < MAX_HANDS
		});
		if (!allowed.includes(action)) return { ok: false, error: `You cannot ${action} right now.` };

		const ctx = { gold, stats: await lockStats(client, userId) };
		t.shuffled = false;
		const h = t.hands[t.active];

		if (action === 'hit') {
			h.cards.push(draw(t));
			const v = handValue(h.cards);
			if (v.bust || v.total === 21) h.done = true;
		} else if (action === 'stand') {
			h.done = true;
		} else if (action === 'double') {
			ctx.gold -= h.bet;
			ctx.stats.goldSpent = (ctx.stats.goldSpent || 0) + h.bet;
			h.bet *= 2;
			h.doubled = true;
			h.cards.push(draw(t));
			h.done = true;
		} else if (action === 'split') {
			ctx.gold -= h.bet;
			ctx.stats.goldSpent = (ctx.stats.goldSpent || 0) + h.bet;
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
			h.cards.push(draw(t));
			next.cards.push(draw(t));
			t.hands.splice(t.active + 1, 0, next);
			// Split aces get exactly one card each and then stand.
			if (splittingAces) {
				h.done = true;
				next.done = true;
			} else {
				if (handValue(h.cards).total === 21) h.done = true;
			}
		}

		advance(t, ctx);

		await writeTable(client, userId, t);
		await setGold(client, userId, ctx.gold);
		await writeStats(client, userId, ctx.stats);

		return { ok: true, table: publicView(t, ctx.gold), gold: ctx.gold };
	});
}

/** Suggested play, from the same basic-strategy table the verifier measures. */
export async function hint(userId) {
	const t = await tableOf(userId);
	if (!t || t.phase !== 'player') return null;
	const h = t.hands[t.active];
	if (!h) return null;
	const gold = await getGold(userId);
	const allowed = legalMoves(h, { gold, canSplitMore: t.hands.length < MAX_HANDS });
	return { allowed, hand: h.cards, dealerUp: t.dealer[0] };
}

async function getGold(userId) {
	const { rows } = await query('SELECT gold FROM wallets WHERE user_id = $1', [userId]);
	return rows[0]?.gold ?? 0;
}

export async function blackjackStats(userId) {
	const s = await readStats(userId);
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
