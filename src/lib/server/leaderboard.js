/**
 * The leaderboard.
 *
 * Eight boards off ONE query. The temptation here is a helper that ranks players
 * by a metric and calling it eight times, which is eight passes over every card
 * and every pack in the database for a page anyone can load — the same mistake the
 * admin panel used to make (see the note on userRows in admin.js). Instead every
 * per-player figure is aggregated once, and the boards are sorts of that one
 * result set in memory, which is trivial at any player count this app will see.
 *
 * The one figure NOT computed here is the buy-back value of a player's unopened
 * packs. It needs `packSellGold`, which reads the in-process TCGplayer cache and
 * the active sale rules rather than anything in Postgres, so net worth on this
 * page is gold plus collection value and says so. It is not the pack hoard that
 * decides these standings.
 */

import { query } from './db.js';
import { MARKET_GOLD_SQL } from './economySql.js';

/** How many places each board shows. */
const PLACES = 10;

/**
 * The boards, in the order they are shown. `pick` reads the metric off an
 * aggregated row; `format` says how the number should be read.
 */
export const BOARDS = [
	{
		id: 'networth',
		title: 'Richest',
		blurb: 'Gold in hand plus everything in the collection.',
		icon: '👑',
		unit: 'gold',
		pick: (r) => r.gold + r.collectionValue
	},
	{
		id: 'collection',
		title: 'Best collection',
		blurb: 'Market value of every card owned.',
		icon: '💎',
		unit: 'gold',
		pick: (r) => r.collectionValue
	},
	{
		id: 'bestpull',
		title: 'Biggest pull',
		blurb: 'The single most valuable card anyone has opened.',
		icon: '🌟',
		unit: 'gold',
		pick: (r) => r.bestPullGold,
		caption: (r) => r.bestPullName
	},
	{
		id: 'cards',
		title: 'Most cards',
		blurb: 'Sheer volume.',
		icon: '🃏',
		unit: 'count',
		pick: (r) => r.cards
	},
	{
		id: 'opened',
		title: 'Most packs ripped',
		blurb: 'Packs opened, all time.',
		icon: '📦',
		unit: 'count',
		pick: (r) => r.packsOpened
	},
	{
		id: 'serials',
		title: 'Serial hunters',
		blurb: 'Numbered cards pulled — there is only ever one of each.',
		icon: '🔢',
		unit: 'count',
		pick: (r) => r.serialized
	},
	{
		id: 'slots',
		title: 'Mana Machine',
		blurb: 'Net gold off the slots, packs included.',
		icon: '🎰',
		unit: 'net',
		pick: (r) => r.slotNet
	},
	{
		id: 'blackjack',
		title: 'Blackjack',
		blurb: 'Net gold at the table.',
		icon: '♠️',
		unit: 'net',
		pick: (r) => r.bjNet
	}
];

/**
 * Every player's figures, in one round trip.
 *
 * The stats blob supplies the game-mode counters; `collections` supplies the
 * card count and the collection value, summed in the database with the same SQL
 * the admin panel uses. Accounts that have done nothing still appear — with
 * zeroes — because a board that silently omits people is confusing, and the sorts
 * below drop them off the end anyway.
 */
async function rows() {
	const { rows } = await query(
		`SELECT u.id, u.username,
		        COALESCE(w.gold, 0)                                   AS gold,
		        COALESCE(c.cards, 0)                                  AS cards,
		        COALESCE(c.value, 0)                                  AS collection_value,
		        COALESCE(i.packs, 0)                                  AS packs,
		        COALESCE((s.data->>'packsOpened')::bigint, 0)         AS packs_opened,
		        COALESCE((s.data->>'serializedPulled')::bigint, 0)    AS serialized,
		        COALESCE((s.data->>'slotWon')::bigint, 0)
		          + COALESCE((s.data->>'slotPackGold')::bigint, 0)
		          - COALESCE((s.data->>'slotWagered')::bigint, 0)     AS slot_net,
		        COALESCE((s.data->>'bjNet')::bigint, 0)               AS bj_net,
		        COALESCE((s.data->'bestPull'->>'gold')::bigint, 0)    AS best_pull_gold,
		        s.data->'bestPull'->>'name'                           AS best_pull_name,
		        s.data->'bestPull'->>'image'                          AS best_pull_image
		   FROM users u
		   LEFT JOIN wallets w ON w.user_id = u.id
		   LEFT JOIN (
		         SELECT user_id, count(*)::int AS cards,
		                COALESCE(SUM(${MARKET_GOLD_SQL}), 0)::bigint AS value
		           FROM collections GROUP BY user_id
		        ) c ON c.user_id = u.id
		   LEFT JOIN (
		         SELECT user_id, count(*)::int AS packs FROM inventory GROUP BY user_id
		        ) i ON i.user_id = u.id
		   LEFT JOIN stats s ON s.user_id = u.id`
	);

	return rows.map((r) => ({
		id: r.id,
		username: r.username,
		gold: r.gold,
		cards: r.cards,
		collectionValue: r.collection_value,
		packs: r.packs,
		packsOpened: r.packs_opened,
		serialized: r.serialized,
		slotNet: r.slot_net,
		bjNet: r.bj_net,
		bestPullGold: r.best_pull_gold,
		bestPullName: r.best_pull_name,
		bestPullImage: r.best_pull_image
	}));
}

/**
 * Every board, ranked.
 *
 * `you` is the signed-in player's placing on each board even when it is outside
 * the top ten, because "you are 14th of 71" is the reason to come back.
 */
export async function leaderboards(forUserId = null) {
	const all = await rows();

	const boards = BOARDS.map((b) => {
		const ranked = all
			.map((r) => ({
				id: r.id,
				username: r.username,
				value: b.pick(r),
				caption: b.caption?.(r) ?? null,
				image: b.id === 'bestpull' ? r.bestPullImage : null
			}))
			// A net figure can be negative and is still a placing; a total cannot be,
			// and a zero means "has not played", which does not belong on a board.
			.filter((r) => (b.unit === 'net' ? r.value !== 0 : r.value > 0))
			.sort((a, b2) => b2.value - a.value);

		ranked.forEach((r, i) => (r.place = i + 1));
		const mine = forUserId ? ranked.find((r) => r.id === forUserId) : null;

		return {
			id: b.id,
			title: b.title,
			blurb: b.blurb,
			icon: b.icon,
			unit: b.unit,
			entries: ranked.slice(0, PLACES),
			ranked: ranked.length,
			you: mine ? { place: mine.place, value: mine.value } : null
		};
	});

	return { boards, players: all.length };
}
