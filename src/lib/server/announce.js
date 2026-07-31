/**
 * System announcements — the pulls and wins the whole server gets told about.
 *
 * Three things earn one, and the thresholds are the point:
 *
 *   * A SERIALIZED card, always. There is exactly one 3/50 of that card in
 *     existence and it has just been claimed forever (see the serials table), so
 *     it is news at any price.
 *   * A card worth ANNOUNCE_GOLD or more. That is a real-money threshold — 500
 *     dollars at the app's 100-gold-per-dollar anchor — not a rarity one, because
 *     "mythic" is common and a bulk mythic is not news.
 *   * A slot win of JACKPOT_MULTIPLE times the stake or more, and every Booster
 *     Vault, which is the five-Booster grid at 1 in 8,192.
 *
 * Writes are best-effort and never inside the caller's critical path in the sense
 * that matters: a failure here is caught and logged, because an announcement that
 * cannot be written must not roll back the rip that earned it.
 */

import { query, makeId } from './db.js';
import { cardMarketGold } from '../economy.js';

/** A card worth this much in gold is announced. 50,000 gold is $500. */
export const ANNOUNCE_GOLD = 50_000;

/** A slot win worth this multiple of the stake is announced. */
export const JACKPOT_MULTIPLE = 100;

/** How many announcements are kept. */
const KEEP = 60;

/** Rows this old stop being shown at all. */
export const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

function rowToItem(r) {
	return {
		id: r.id,
		at: r.at,
		kind: r.kind,
		username: r.username,
		headline: r.headline,
		detail: r.detail,
		gold: r.gold,
		image: r.image
	};
}

/**
 * Write one announcement.
 *
 * `client` is the transaction's client when there is one, so an announcement for
 * a rip lands and rolls back with it. Failures are swallowed: this is a
 * noticeboard, and no noticeboard is worth failing a purchase over.
 */
export async function announce(client, { kind, username, headline, detail, gold, image }) {
	const run = client ? client.query.bind(client) : query;
	try {
		await run(
			`INSERT INTO announcements (id, at, kind, username, headline, detail, gold, image)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				makeId(),
				Date.now(),
				String(kind || 'card'),
				String(username || 'someone'),
				String(headline || '').slice(0, 200),
				detail ? String(detail).slice(0, 200) : null,
				gold == null ? null : Math.round(gold),
				image ? String(image).slice(0, 400) : null
			]
		);
	} catch (e) {
		console.error('announce: could not post —', e.message);
	}
}

/**
 * Trim to the cap. Not done on every write — a mass rip can post several
 * announcements in one transaction and there is no reason to prune between them —
 * so the caller does it once when it is finished.
 */
export async function pruneAnnouncements(client) {
	const run = client ? client.query.bind(client) : query;
	try {
		await run(
			`DELETE FROM announcements WHERE id NOT IN (
			   SELECT id FROM announcements ORDER BY at DESC, id DESC LIMIT $1
			 )`,
			[KEEP]
		);
	} catch (e) {
		console.error('announce: could not prune —', e.message);
	}
}

/**
 * Decide whether a freshly pulled card is worth announcing, and say why.
 * Pure — the caller writes the row, so this can be reasoned about on its own.
 * @returns {{headline:string, detail:string, gold:number, kind:string}|null}
 */
export function cardAnnouncement(card, username) {
	const gold = cardMarketGold(card.valueUsd);
	const serialized = card.serial != null && card.serialOf;
	if (!serialized && gold < ANNOUNCE_GOLD) return null;

	const finish = card.finish === 'etched' ? ' etched' : card.foil ? ' foil' : '';
	const where = card.setName || String(card.set || '').toUpperCase();

	if (serialized) {
		return {
			kind: 'serial',
			headline: `${username} pulled ${card.name} ${card.serial}/${card.serialOf}`,
			detail: `Serialized${finish} — ${where}. There will never be another one.`,
			gold
		};
	}
	return {
		kind: 'card',
		headline: `${username} pulled ${card.name}`,
		detail: `${(card.rarity || '').toUpperCase()}${finish} — ${where}`,
		gold
	};
}

/** Recent announcements, newest first. */
export async function recentAnnouncements(limit = 20, since = 0) {
	const cutoff = Math.max(Number(since) || 0, Date.now() - MAX_AGE_MS);
	const { rows } = await query(
		'SELECT * FROM announcements WHERE at > $1 ORDER BY at DESC LIMIT $2',
		[cutoff, Math.max(1, Math.min(KEEP, Number(limit) || 20))]
	);
	return rows.map(rowToItem);
}
