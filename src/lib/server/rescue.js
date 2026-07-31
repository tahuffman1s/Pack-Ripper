/**
 * The Bulk Bin — the failsafe that makes it impossible to get stuck.
 *
 * A player is stuck when they cannot take ANY action: not enough gold to spin
 * or buy a pack, no unopened packs to crack, and no cards worth selling. That
 * is a dead end with no way out, so when it happens the shop lets them rummage
 * through the bulk bin and keep what they find.
 *
 * The grant is deliberately modest — enough to get moving again, not enough to
 * be worth farming. It is also gated entirely server-side on genuinely being
 * stuck, so it cannot be claimed on demand.
 */

import { query, tx, lockGold, setGold, lockStats, writeStats, makeId } from './db.js';
import { COLLECTION_SELL_VALUE_SQL } from './economySql.js';
import { COLLECTION_COLUMNS, cardToValues, valuesClause } from './rows.js';
import { packSellGold } from './game.js';
import { loadSales } from './sales.js';
import { setEntry, storeSets } from './registry.js';
import { getSetPool, cachedPoolCodes } from './scryfall.js';
import { cardSellGold } from '../economy.js';
import { MIN_TOTAL_BET } from '../slots.js';

/**
 * Below this total worth there is nothing at all the player can do — not even
 * the smallest bet on the slot machine.
 */
export const STUCK_BELOW = MIN_TOTAL_BET;

/** Rescue aims to leave them with roughly this much, so a few spins do not re-strand them. */
export const RESCUE_TARGET = 300;

/** Hard ceiling on how many cards a single rummage can produce. */
const MAX_CARDS = 15;

/**
 * Everything the player could turn into gold right now: gold in hand, what the
 * shop would pay for their cards, and the buy-back value of unopened packs.
 *
 * This runs on EVERY page load, because the layout uses it to decide whether to
 * show the Bulk Bin banner. It used to load the entire collection and the entire
 * vault to add up two numbers; now the card total is summed in the database and
 * the vault is grouped by product, so the rows that come back are one per set and
 * pack type rather than one per card.
 *
 * The pack total still has to be finished in JS: packSellGold() reads the live
 * TCGplayer cache, the vintage EV floors and the active sale rules, all of which
 * are in-process and not in Postgres. Grouping is what makes that cheap — it is called once per distinct
 * product, not once per pack.
 */
export async function netWorthGold(userId) {
	// What a pack is worth at the counter moves with an active sale, and being
	// stuck is decided on what the player could actually realise.
	await loadSales();
	const [walletAndCards, byProduct] = await Promise.all([
		query(
			`SELECT COALESCE((SELECT gold FROM wallets WHERE user_id = $1), 0) AS gold,
			        COALESCE((${COLLECTION_SELL_VALUE_SQL}), 0) AS cards`,
			[userId]
		),
		query(
			`SELECT set_code, pack_type_id, count(*)::int AS count
			   FROM inventory WHERE user_id = $1
			  GROUP BY set_code, pack_type_id`,
			[userId]
		)
	]);

	const gold = walletAndCards.rows[0].gold;
	const cards = walletAndCards.rows[0].cards;

	let packs = 0;
	for (const r of byProduct.rows) {
		const set = setEntry(r.set_code);
		if (set) packs += packSellGold(set, r.pack_type_id) * r.count;
	}

	return { gold, cards, packs, total: gold + cards + packs };
}

/** True when the player has no move left. */
export async function isStuck(userId) {
	return (await netWorthGold(userId)).total < STUCK_BELOW;
}

/**
 * Sets to rummage through. Prefers sets whose card pool is already cached so a
 * rescue never blocks on the network — being stuck is exactly the moment the
 * app must respond instantly.
 */
async function rummagePool() {
	const sets = storeSets().filter((s) => !s.unreleased);
	if (!sets.length) return null;

	// Sets whose pool is already on disk come first — for those getSetPool is a
	// local read, so a rescue costs no network round trip.
	const warm = new Set(cachedPoolCodes());
	const tried = new Set();
	const order = [
		...sets.filter((s) => warm.has(s.code)),
		...sets.filter((s) => s.featured),
		...sets
	];

	for (const s of order) {
		if (tried.has(s.code)) continue;
		tried.add(s.code);
		try {
			const pool = await getSetPool(s.code);
			const all = [
				...pool.cards.common,
				...pool.cards.uncommon,
				...pool.cards.rare,
				...pool.cards.mythic
			].filter((c) => c && (c.usd ?? 0) > 0);
			if (all.length >= 20) return { set: s, cards: all };
		} catch {
			/* try the next set */
		}
		if (tried.size >= 4) break; // bound the work; four sets is plenty
	}
	return null;
}

function instanceFor(card, setName) {
	return {
		uid: makeId(),
		id: card.id,
		oracleId: card.oracleId,
		name: card.name,
		set: card.set,
		setName: card.setName || setName,
		number: card.number,
		rarity: card.rarity,
		colors: card.colors || [],
		manaCost: card.manaCost || '',
		typeLine: card.typeLine || '',
		images: card.images,
		scryfallUri: card.scryfallUri,
		foil: false,
		finish: 'nonfoil',
		isList: false,
		fromSet: null,
		treatments: [],
		slot: 'bulk',
		slotLabel: 'Bulk Bin',
		tier: 1,
		sheet: null,
		serial: null,
		serialOf: null,
		estimated: false,
		valueUsd: Number((card.usd ?? 0).toFixed(2))
	};
}

/**
 * Hand over a rummaged pile of cards worth roughly RESCUE_TARGET in sell value.
 * Refuses unless the player is actually stuck.
 */
export async function rescue(userId) {
	const before = await netWorthGold(userId);
	if (before.total >= STUCK_BELOW) {
		return { ok: false, error: 'You still have something to work with.' };
	}

	const found = await rummagePool();
	const granted = [];
	let value = before.total;

	if (found) {
		const { set, cards } = found;
		// A bulk bin holds bulk. Cap what any single card can be worth so the
		// rescue is a pile of playables rather than an accidental chase mythic —
		// without a ceiling one lucky draw can overshoot the target 3x.
		const ceiling = RESCUE_TARGET / 2;
		const inRange = (c) => {
			const g = cardSellGold(c.usd);
			return g >= 10 && g <= ceiling;
		};
		const bin = cards.filter(inRange);
		const pool = bin.length >= 8 ? bin : cards.filter((c) => cardSellGold(c.usd) <= ceiling);

		while (pool.length && granted.length < MAX_CARDS && value < RESCUE_TARGET) {
			const card = pool[Math.floor(Math.random() * pool.length)];
			const inst = instanceFor(card, set.name);
			granted.push(inst);
			value += cardSellGold(inst.valueUsd);
		}
	}

	// Last resort: if there is no usable card data at all (cold cache, no
	// network), hand over plain gold. The failsafe must never itself fail.
	const shortfall = Math.max(0, RESCUE_TARGET - value);

	const now = Date.now();
	const walletGold = await tx(async (client) => {
		const gold = await lockGold(client, userId);
		if (gold == null) throw new Error('No wallet.');

		if (granted.length) {
			for (const c of granted) {
				c.acquiredAt = now;
				c.sold = false;
			}
			await client.query(
				`INSERT INTO collections (${COLLECTION_COLUMNS.join(', ')})
				 VALUES ${valuesClause(granted.length, COLLECTION_COLUMNS.length)}`,
				granted.flatMap((c) => cardToValues(userId, c))
			);
		}

		const s = await lockStats(client, userId);
		if (shortfall > 0) {
			await setGold(client, userId, gold + shortfall);
			s.goldEarned = (s.goldEarned || 0) + shortfall;
		}
		s.rescues = (s.rescues || 0) + 1;
		await writeStats(client, userId, s);

		return gold + shortfall;
	});

	return {
		ok: true,
		cards: granted,
		gold: shortfall,
		setName: found?.set?.name || null,
		worth: await netWorthGold(userId),
		walletGold
	};
}
