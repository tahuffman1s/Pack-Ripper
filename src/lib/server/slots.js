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
 * Free spins are server state (the free_spins table), not a client flag. They
 * lock in the stake from the triggering spin, cost nothing, and cannot
 * retrigger — which is exactly the model the RTP solver assumes.
 */

import { randomInt } from 'node:crypto';
import { query, tx, lockGold, setGold, lockStats, writeStats, readStats } from './db.js';
import {
	REELS,
	DEFAULT_BET,
	DEFAULT_LINES,
	isValidBet,
	isValidLines,
	totalBet,
	evaluateSpin
} from '../slots.js';

export async function getWalletGold(userId) {
	const { rows } = await query('SELECT gold FROM wallets WHERE user_id = $1', [userId]);
	return rows.length ? rows[0].gold : 0;
}

/** Free-spin state, or null. */
export async function freeSpinState(userId) {
	const { rows } = await query(
		'SELECT remaining, line_bet, lines FROM free_spins WHERE user_id = $1',
		[userId]
	);
	if (!rows.length) return null;
	return { remaining: rows[0].remaining, lineBet: rows[0].line_bet, lines: rows[0].lines };
}

/**
 * Spin once.
 *
 * Everything — debit, roll, credit, free-spin bookkeeping, stats — happens in a
 * single transaction, so a spin can never half-apply and leave gold missing.
 *
 * The wallet and the free-spin row are both locked before anything is decided.
 * That used to be free: the balance test and the debit were adjacent lines in a
 * synchronous function, so nothing could run between them. They are separated by
 * awaits now, and without the lock two spins fired at once could both pass the
 * affordability check against the same balance and both be paid for once.
 *
 * @param {string} userId
 * @param {{bet?:number, lines?:number}} [opts]
 */
export async function spin(userId, opts = {}) {
	return tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) return { ok: false, error: 'No wallet.' };

		const { rows: fsRows } = await client.query(
			'SELECT remaining, line_bet, lines FROM free_spins WHERE user_id = $1 FOR UPDATE',
			[userId]
		);
		const free = fsRows.length
			? { remaining: fsRows[0].remaining, lineBet: fsRows[0].line_bet, lines: fsRows[0].lines }
			: null;

		// During a free-spin round the stake is fixed at whatever triggered it, so
		// nothing the client sends can change what a free spin is worth.
		const lineBet = free ? free.lineBet : Number(opts.bet ?? DEFAULT_BET);
		const lines = free ? free.lines : Number(opts.lines ?? DEFAULT_LINES);

		if (!isValidBet(lineBet)) return { ok: false, error: 'Invalid bet.' };
		if (!isValidLines(lines)) return { ok: false, error: 'Invalid line count.' };

		const stake = totalBet(lineBet, lines);
		const cost = free ? 0 : stake;
		if (gold < cost) {
			return {
				ok: false,
				error: `You need ${stake} gold for ${lines} line${lines === 1 ? '' : 's'} at ${lineBet}.`
			};
		}

		// Pick a stop on each physical reel strip, uniformly. The symbol odds come
		// from how often a symbol appears on the strip, exactly like a real machine.
		const stops = REELS.map((strip) => randomInt(strip.length));
		const result = evaluateSpin(stops, lines, lineBet);

		// A free spin cannot award more free spins — the RTP solver folds the bonus
		// in as a single non-retriggering round, and allowing retriggers here would
		// silently push the real return above the published number.
		const awarded = free ? 0 : result.freeSpins;

		await setGold(client, userId, gold - cost + result.win);

		let freeAfter = null;
		if (free) {
			const remaining = free.remaining - 1;
			if (remaining > 0) {
				await client.query('UPDATE free_spins SET remaining = $2 WHERE user_id = $1', [
					userId,
					remaining
				]);
				freeAfter = { ...free, remaining };
			} else {
				// Deleted rather than set to zero: the table's CHECK (remaining > 0)
				// makes "no free spins" the absence of a row, so there is exactly one
				// representation of it.
				await client.query('DELETE FROM free_spins WHERE user_id = $1', [userId]);
			}
		} else if (awarded > 0) {
			await client.query(
				`INSERT INTO free_spins (user_id, remaining, line_bet, lines) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (user_id) DO UPDATE
				   SET remaining = EXCLUDED.remaining,
				       line_bet  = EXCLUDED.line_bet,
				       lines     = EXCLUDED.lines`,
				[userId, awarded, lineBet, lines]
			);
			freeAfter = { remaining: awarded, lineBet, lines };
		}

		const s = await lockStats(client, userId);
		s.goldSpent = (s.goldSpent || 0) + cost;
		if (result.win > 0) s.goldEarned = (s.goldEarned || 0) + result.win;
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
		await writeStats(client, userId, s);

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
			gold: gold - cost + result.win
		};
	});
}

/** Slot-specific stats for the stats page. */
export async function slotStats(userId) {
	const s = await readStats(userId);
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
