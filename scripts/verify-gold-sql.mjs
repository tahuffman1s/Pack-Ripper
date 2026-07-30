#!/usr/bin/env node
/**
 * Prove that the SQL gold conversions in economySql.js agree with the JS ones in
 * economy.js, over every price actually in the database.
 *
 * economySql.js is a second implementation of usdToGold() and cardSellGold(),
 * which exists because valuing a collection has to be a SUM in the database
 * rather than a few thousand rows shipped out to be added up in JS. A duplicated
 * money rule is only acceptable if something checks it, and this is that
 * something.
 *
 *   DATABASE_URL=postgres://... node scripts/verify-gold-sql.mjs
 *
 * Exits non-zero on any disagreement, so it can gate a deploy.
 */

import { initDb, query } from '../src/lib/server/db.js';
import { MARKET_GOLD_SQL, SELL_GOLD_SQL } from '../src/lib/server/economySql.js';
import { cardMarketGold, cardSellGold } from '../src/lib/economy.js';

await initDb();

// Every DISTINCT price, not every row: the conversion is a pure function of the
// price, so a set of 400 distinct values covers a collection of 3,153 cards.
// Plus the awkward ones by hand, which a real collection may not happen to have:
// zero, sub-cent values that must floor to a minimum of 1 gold rather than 0, and
// exact half-cents where rounding direction is the thing being tested.
const { rows: present } = await query(
	'SELECT DISTINCT value_usd FROM collections ORDER BY value_usd'
);

const EDGE_CASES = [
	0, 0.001, 0.004, 0.005, 0.006, 0.01, 0.015, 0.02, 0.025, 0.99, 1, 1.005, 1.5, 2.5,
	3.99, 4.995, 9.995, 10, 99.99, 100, 1234.56, 99999.99
];

const prices = [...new Set([...present.map((r) => r.value_usd), ...EDGE_CASES])];

// One round trip: hand the whole list to Postgres as an array and evaluate both
// expressions against it. The column has to be named value_usd because that is
// what the SQL fragments reference.
const { rows: fromSql } = await query(
	`SELECT value_usd,
	        (${MARKET_GOLD_SQL})::bigint AS market,
	        (${SELL_GOLD_SQL})::bigint   AS sell
	   FROM unnest($1::double precision[]) AS value_usd`,
	[prices]
);

let checked = 0;
const bad = [];
for (const r of fromSql) {
	const jsMarket = cardMarketGold(r.value_usd);
	const jsSell = cardSellGold(r.value_usd);
	checked++;
	if (jsMarket !== r.market || jsSell !== r.sell) {
		bad.push({ usd: r.value_usd, jsMarket, sqlMarket: r.market, jsSell, sqlSell: r.sell });
	}
}

// And the aggregate, which is what the app actually calls — a per-price match
// still leaves room for the SUM to be wrong (a bad cast, an int8 arriving as a
// string and concatenating instead of adding).
const { rows: totals } = await query(
	`SELECT COALESCE(SUM(${MARKET_GOLD_SQL}), 0)::bigint AS market,
	        COALESCE(SUM(${SELL_GOLD_SQL}), 0)::bigint   AS sell
	   FROM collections`
);
const { rows: all } = await query('SELECT value_usd FROM collections');
const jsTotalMarket = all.reduce((a, r) => a + cardMarketGold(r.value_usd), 0);
const jsTotalSell = all.reduce((a, r) => a + cardSellGold(r.value_usd), 0);

console.log(`prices checked:   ${checked} (${present.length} from the database + edge cases)`);
console.log(`collection rows:  ${all.length}`);
console.log(`market total:     js ${jsTotalMarket}  sql ${totals[0].market}`);
console.log(`sell total:       js ${jsTotalSell}  sql ${totals[0].sell}`);

if (bad.length) {
	console.error(`\nFAIL — ${bad.length} price(s) disagree:`);
	for (const b of bad.slice(0, 20)) {
		console.error(
			`  $${b.usd}: market js=${b.jsMarket} sql=${b.sqlMarket}, sell js=${b.jsSell} sql=${b.sqlSell}`
		);
	}
	process.exit(1);
}
if (jsTotalMarket !== totals[0].market || jsTotalSell !== totals[0].sell) {
	console.error('\nFAIL — per-price conversions agree but the aggregates do not.');
	process.exit(1);
}

console.log('\nOK — every price and both totals agree.');
process.exit(0);
