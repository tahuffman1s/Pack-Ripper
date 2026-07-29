/**
 * Slot machine — server side.
 *
 * The spin is rolled HERE and nowhere else. The client is handed the three reel
 * stops after the fact and animates to them; it never decides an outcome, so a
 * tampered client can win exactly nothing extra.
 *
 * Randomness comes from node:crypto rather than Math.random — this moves the
 * player's balance, so it gets a real CSPRNG with no modulo bias.
 *
 * Free spins are server state (`db.freeSpins[userId]`), not a client flag. They
 * lock in the stake from the triggering spin, cost nothing, and cannot
 * retrigger — which is exactly the model the RTP solver assumes.
 */

import { randomInt } from 'node:crypto';
import { getDb, mutate } from './db.js';
import { newStats } from './auth.js';
import {
	REELS,
	DEFAULT_BET,
	DEFAULT_LINES,
	isValidBet,
	isValidLines,
	totalBet,
	evaluateSpin
} from '../slots.js';

export function getWalletGold(userId) {
	return getDb().wallets[userId]?.gold ?? 0;
}

/** Free-spin state, or null. */
export function freeSpinState(userId) {
	const fs = getDb().freeSpins?.[userId];
	return fs && fs.remaining > 0 ? { ...fs } : null;
}

/**
 * Spin once.
 *
 * Everything — debit, roll, credit, free-spin bookkeeping, stats — happens in a
 * single mutate() so a spin can never half-apply and leave gold missing.
 *
 * @param {string} userId
 * @param {{bet?:number, lines?:number}} [opts]
 */
export function spin(userId, opts = {}) {
	const db = getDb();
	const wallet = db.wallets[userId];
	if (!wallet) return { ok: false, error: 'No wallet.' };

	const free = freeSpinState(userId);

	// During a free-spin round the stake is fixed at whatever triggered it, so
	// nothing the client sends can change what a free spin is worth.
	const lineBet = free ? free.lineBet : Number(opts.bet ?? DEFAULT_BET);
	const lines = free ? free.lines : Number(opts.lines ?? DEFAULT_LINES);

	if (!isValidBet(lineBet)) return { ok: false, error: 'Invalid bet.' };
	if (!isValidLines(lines)) return { ok: false, error: 'Invalid line count.' };

	const stake = totalBet(lineBet, lines);
	const cost = free ? 0 : stake;
	if (wallet.gold < cost) {
		return { ok: false, error: `You need ${stake} gold for ${lines} line${lines === 1 ? '' : 's'} at ${lineBet}.` };
	}

	// Pick a stop on each physical reel strip, uniformly. The symbol odds come
	// from how often a symbol appears on the strip, exactly like a real machine.
	const stops = REELS.map((strip) => randomInt(strip.length));
	const result = evaluateSpin(stops, lines, lineBet);

	// A free spin cannot award more free spins — the RTP solver folds the bonus
	// in as a single non-retriggering round, and allowing retriggers here would
	// silently push the real return above the published number.
	const awarded = free ? 0 : result.freeSpins;

	let freeAfter = null;
	mutate((d) => {
		const w = d.wallets[userId];
		w.gold = w.gold - cost + result.win;

		d.freeSpins ??= {};
		const cur = d.freeSpins[userId];
		if (free) {
			const remaining = cur.remaining - 1;
			if (remaining > 0) d.freeSpins[userId] = { ...cur, remaining };
			else delete d.freeSpins[userId];
		} else if (awarded > 0) {
			d.freeSpins[userId] = { remaining: awarded, lineBet, lines };
		}
		freeAfter = d.freeSpins[userId] ? { ...d.freeSpins[userId] } : null;

		const s = (d.stats[userId] ??= newStats());
		s.goldSpent += cost;
		if (result.win > 0) s.goldEarned += result.win;
		s.slotSpins = (s.slotSpins || 0) + 1;
		s.slotWagered = (s.slotWagered || 0) + cost;
		s.slotWon = (s.slotWon || 0) + result.win;
		if (free) s.slotFreeSpinsPlayed = (s.slotFreeSpinsPlayed || 0) + 1;
		if (awarded > 0) s.slotBonuses = (s.slotBonuses || 0) + 1;
		if (result.win > (s.slotBest?.win ?? 0)) {
			s.slotBest = {
				win: result.win,
				label: result.lineWins[0]?.label || (result.scatterHit ? 'Booster Bonus' : ''),
				lineBet,
				lines,
				at: Date.now()
			};
		}
	});

	return {
		ok: true,
		stops,
		grid: result.grid,
		lineWins: result.lineWins,
		scatterCells: result.scatterCells,
		scatterHit: result.scatterHit,
		scatterWin: result.scatterWin,
		win: result.win,
		cost,
		stake,
		lineBet,
		lines,
		wasFree: !!free,
		awardedFreeSpins: awarded,
		freeSpinsLeft: freeAfter?.remaining ?? 0,
		gold: getWalletGold(userId)
	};
}

/** Slot-specific stats for the stats page. */
export function slotStats(userId) {
	const s = getDb().stats[userId] || {};
	const spins = s.slotSpins || 0;
	const wagered = s.slotWagered || 0;
	const won = s.slotWon || 0;
	return {
		spins,
		wagered,
		won,
		net: won - wagered,
		returnPct: wagered > 0 ? won / wagered : null,
		bonuses: s.slotBonuses || 0,
		freeSpinsPlayed: s.slotFreeSpinsPlayed || 0,
		best: s.slotBest || null
	};
}
