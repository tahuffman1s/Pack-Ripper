/**
 * Blackjack — pure rules, shared between client and server.
 *
 * House rules, chosen to be the player-friendly end of standard casino play:
 *
 *   6-deck shoe, reshuffled once three quarters of it is spent
 *   Dealer STANDS on soft 17
 *   Blackjack pays 3:2
 *   Double on any first two cards, including after a split
 *   Split any pair, up to 4 hands; split aces get one card each and stand
 *   No insurance and no surrender (see the note on insurance below)
 *
 * With correct basic strategy those rules give a house edge of roughly half a
 * percent. `node scripts/verify-blackjack.mjs` measures it rather than assuming
 * it, and also checks hand evaluation exhaustively.
 *
 * Insurance is deliberately absent: it is a side bet on the dealer holding a
 * ten, paying 2:1 on a roughly 9:4 shot, so it is always worse for the player
 * than declining. Rather than offer a trap, the game just peeks and moves on.
 */

export const DECKS = 6;
export const RESHUFFLE_AT = 0.25; // reshuffle when this fraction of the shoe is left
export const BLACKJACK_PAYOUT = 1.5; // 3:2
export const MAX_HANDS = 4; // one original plus three splits
export const DEALER_STANDS_ON = 17; // and stands on soft 17

/**
 * Bet ladder. A fixed allow-list rather than a range, for the same reason as the
 * slot machine's: the server validates the stake against this list instead of
 * range-checking arbitrary input.
 *
 * It runs to a million a hand, which is the point of a table as opposed to a slot
 * — blackjack at correct play gives back 99.5% of what crosses it, so it is the
 * one game in the app where a serious bankroll can sensibly be put to work, and
 * capping it at a thousand made that impossible. The bottom of the ladder stays at
 * 25 so a player who has just been rescued from the bulk bin can still sit down.
 *
 * A double or a split needs the stake AGAIN, and a hand split three ways and
 * doubled can therefore commit eight times the base bet. legalMoves() checks the
 * balance for each of those against the locked wallet, so the top of the ladder is
 * playable rather than nominal.
 */
export const BET_LEVELS = [25, 100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000];
export const MIN_BET = BET_LEVELS[0];
export const MAX_BET = BET_LEVELS[BET_LEVELS.length - 1];
export const DEFAULT_BET = 500;

export function isValidBet(bet) {
	return Number.isInteger(bet) && BET_LEVELS.includes(bet);
}

export function maxAffordableBet(gold) {
	let best = null;
	for (const b of BET_LEVELS) if (b <= gold) best = b;
	return best;
}

export function stepBet(bet, dir, gold = Infinity) {
	const i = BET_LEVELS.indexOf(bet);
	const next = BET_LEVELS[Math.min(BET_LEVELS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
	if (next > gold) return maxAffordableBet(gold) ?? BET_LEVELS[0];
	return next;
}

// ── Cards ──────────────────────────────────────────────────────

/** Suits are the mana colours, because this is a Magic app. */
export const SUITS = [
	{ id: 'w', glyph: '☀', label: 'Plains', color: '#fdf6d8', text: '#57534e' },
	{ id: 'u', glyph: '💧', label: 'Island', color: '#a5d8f3', text: '#0c4a6e' },
	{ id: 'b', glyph: '☠', label: 'Swamp', color: '#b9aeaa', text: '#1c1917' },
	{ id: 'r', glyph: '🔥', label: 'Mountain', color: '#f4a58a', text: '#7f1d1d' }
];

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** A card is encoded as "rank:suit" so hands stay compact in the database. */
export function makeCard(rank, suit) {
	return `${rank}:${suit}`;
}
export function cardRank(card) {
	return card.slice(0, card.indexOf(':'));
}
export function cardSuit(card) {
	return card.slice(card.indexOf(':') + 1);
}
export function suitInfo(id) {
	return SUITS.find((s) => s.id === id) || SUITS[0];
}

/** One full shoe, unshuffled. */
export function buildShoe(decks = DECKS) {
	const shoe = [];
	for (let d = 0; d < decks; d++) {
		for (const s of SUITS) for (const r of RANKS) shoe.push(makeCard(r, s.id));
	}
	return shoe;
}

/** Blackjack card value; aces count 11 here and are demoted by handValue. */
export function rankValue(rank) {
	if (rank === 'A') return 11;
	if (rank === 'K' || rank === 'Q' || rank === 'J') return 10;
	return Number(rank);
}

// ── Hands ──────────────────────────────────────────────────────

/**
 * Evaluate a hand.
 * `soft` means an ace is still being counted as 11, so the hand cannot bust on
 * the next card — that distinction drives both dealer play and basic strategy.
 * @returns {{total:number, soft:boolean, bust:boolean, blackjack:boolean}}
 */
export function handValue(cards) {
	let total = 0;
	let aces = 0;
	for (const c of cards) {
		const r = cardRank(c);
		if (r === 'A') aces++;
		total += rankValue(r);
	}
	// Demote aces from 11 to 1 until the hand survives, or we run out.
	while (total > 21 && aces > 0) {
		total -= 10;
		aces--;
	}
	return {
		total,
		soft: aces > 0 && total <= 21,
		bust: total > 21,
		blackjack: cards.length === 2 && total === 21
	};
}

export function isPair(cards) {
	if (cards.length !== 2) return false;
	return rankValue(cardRank(cards[0])) === rankValue(cardRank(cards[1]));
}

/** Which moves are legal for a hand right now. */
export function legalMoves(hand, { gold, canSplitMore }) {
	if (hand.done) return [];
	const v = handValue(hand.cards);
	if (v.bust || v.total === 21) return [];
	// Split aces receive exactly one card and then stand.
	if (hand.fromSplitAce && hand.cards.length >= 2) return [];

	const moves = ['hit', 'stand'];
	const fresh = hand.cards.length === 2 && !hand.doubled;
	if (fresh && gold >= hand.bet) moves.push('double');
	if (fresh && canSplitMore && isPair(hand.cards) && gold >= hand.bet) moves.push('split');
	return moves;
}

/** Dealer draws to 17 and stands on all 17s, soft included. */
export function dealerShouldHit(cards) {
	const v = handValue(cards);
	if (v.bust) return false;
	return v.total < DEALER_STANDS_ON;
}

/**
 * Settle one player hand against the dealer.
 * @returns {{outcome:'blackjack'|'win'|'push'|'lose', payout:number, delta:number}}
 * `payout` is what comes back to the wallet (stake included); `delta` is the
 * net change, which is what the stats and the UI care about.
 */
export function settleHand(hand, dealerCards) {
	const p = handValue(hand.cards);
	const d = handValue(dealerCards);
	const bet = hand.bet;

	// A split hand making 21 is not a blackjack, only the original two cards can be.
	const playerBJ = p.blackjack && !hand.fromSplit;
	const dealerBJ = d.blackjack;

	if (p.bust) return { outcome: 'lose', payout: 0, delta: -bet };
	if (playerBJ && dealerBJ) return { outcome: 'push', payout: bet, delta: 0 };
	if (playerBJ) {
		const win = Math.round(bet * BLACKJACK_PAYOUT);
		return { outcome: 'blackjack', payout: bet + win, delta: win };
	}
	if (dealerBJ) return { outcome: 'lose', payout: 0, delta: -bet };
	if (d.bust) return { outcome: 'win', payout: bet * 2, delta: bet };
	if (p.total > d.total) return { outcome: 'win', payout: bet * 2, delta: bet };
	if (p.total < d.total) return { outcome: 'lose', payout: 0, delta: -bet };
	return { outcome: 'push', payout: bet, delta: 0 };
}

// ── Basic strategy ─────────────────────────────────────────────
// Used by the verifier to measure the real house edge, and by the in-game
// "hint" so the player can learn correct play. Standard tables for a 6-deck
// S17 game with double-after-split allowed and no surrender.
//
// Actions: H hit, S stand, D double (hit if doubling is not allowed),
//          P split.

const DEALER_INDEX = { 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: 8, A: 9 };

// Rows are hard totals 5..17+, columns dealer 2,3,4,5,6,7,8,9,10,A
const HARD = {
	5: 'HHHHHHHHHH', 6: 'HHHHHHHHHH', 7: 'HHHHHHHHHH',
	8: 'HHHHHHHHHH',
	9: 'HDDDDHHHHH',
	10: 'DDDDDDDDHH',
	11: 'DDDDDDDDDD',
	12: 'HHSSSHHHHH',
	13: 'SSSSSHHHHH', 14: 'SSSSSHHHHH', 15: 'SSSSSHHHHH', 16: 'SSSSSHHHHH',
	17: 'SSSSSSSSSS'
};

// Soft totals by the non-ace card: A2 .. A9
const SOFT = {
	2: 'HHHDDHHHHH', 3: 'HHHDDHHHHH',
	4: 'HHDDDHHHHH', 5: 'HHDDDHHHHH',
	6: 'HDDDDHHHHH',
	7: 'SDDDDSSHHH',
	8: 'SSSSSSSSSS', 9: 'SSSSSSSSSS'
};

// Pairs by rank value: 2..9, 10 (tens), 11 (aces)
const PAIRS = {
	2: 'PPPPPPHHHH', 3: 'PPPPPPHHHH',
	4: 'HHHPPHHHHH',
	5: 'DDDDDDDDHH', // never split fives — play them as a hard ten
	6: 'PPPPPHHHHH',
	7: 'PPPPPPHHHH',
	8: 'PPPPPPPPPP',
	9: 'PPPPPSPPSS',
	10: 'SSSSSSSSSS',
	11: 'PPPPPPPPPP'
};

/**
 * The correct play for a hand.
 * @param {string[]} cards player's cards
 * @param {string} dealerUp the dealer's face-up card
 * @param {{canDouble:boolean, canSplit:boolean}} allowed
 * @returns {'hit'|'stand'|'double'|'split'}
 */
export function basicStrategy(cards, dealerUp, { canDouble = true, canSplit = true } = {}) {
	const upRank = cardRank(dealerUp);
	const col = DEALER_INDEX[upRank === 'J' || upRank === 'Q' || upRank === 'K' ? 10 : upRank];
	const v = handValue(cards);

	const resolve = (code) => {
		if (code === 'D') return canDouble ? 'double' : 'hit';
		if (code === 'P') return 'split';
		return code === 'S' ? 'stand' : 'hit';
	};

	if (canSplit && isPair(cards)) {
		const pv = rankValue(cardRank(cards[0]));
		const row = PAIRS[pv];
		if (row) {
			const code = row[col];
			if (code === 'P') return 'split';
			// Fall through for non-split pairs (fives, tens) to the normal tables.
			if (pv === 5 || pv === 10) return resolve(code);
		}
	}

	if (v.soft) {
		// The "other" card of a soft hand, e.g. soft 18 -> 7.
		const other = v.total - 11;
		const row = SOFT[other];
		if (row) return resolve(row[col]);
		return v.total >= 19 ? 'stand' : 'hit';
	}

	const total = Math.min(Math.max(v.total, 5), 17);
	return resolve(HARD[total][col]);
}
