/**
 * The gold conversions from economy.js, as SQL.
 *
 * ── Read this before changing economy.js ──────────────────────────────────────
 *
 * These are a SECOND implementation of usdToGold() and cardSellGold(). That is a
 * duplicated money rule, which is normally the wrong trade — it is here because
 * the alternative is worse: valuing a collection is `SELECT sum(...)` over a few
 * thousand rows, and doing it in JS means shipping every one of those rows out of
 * the database on every page load to add up one number. The layout loads a
 * collection total on EVERY request, so that is the hot path.
 *
 * The duplication is defended by scripts/verify-gold-sql.mjs, which runs both
 * implementations over every price in the live database plus a list of awkward
 * ones, and fails on any disagreement. If you change economy.js, change these,
 * and run that.
 *
 * ── Why FLOOR(x + 0.5) and not ROUND(x) ──────────────────────────────────────
 *
 * Because the arithmetic has to be done in DOUBLE PRECISION, exactly as JS does
 * it, and Postgres has no rounding function that then matches Math.round.
 *
 * The tempting version of this used `ROUND(value_usd::numeric * 100)`, on the
 * reasoning that numeric is exact so ROUND would never have to break a tie, and
 * that numeric breaks ties away from zero like Math.round does. Both halves of
 * that are true and the conclusion was still wrong, because the CAST changes the
 * value: `1.005::double` is really 1.00499999999999989, and casting it to numeric
 * yields the shortest decimal that round-trips — '1.005' — so the product becomes
 * exactly 100.5 and rounds UP to 101. JS multiplies the actual binary double and
 * gets 100.49999999999999, which rounds DOWN to 100. The verifier caught it on
 * $1.005 and $9.995.
 *
 * So: no cast, and FLOOR(x + 0.5), which is what Math.round is specified to be.
 * `ROUND(double)` is not the answer either — it is documented as
 * platform-dependent and in practice rounds halves to EVEN, so it disagrees with
 * Math.round on every exact tie.
 *
 * The one input where FLOOR(x + 0.5) and Math.round genuinely differ is x just
 * below 0.5 (Math.round(0.49999999999999994) is 0 by spec, while x + 0.5 rounds
 * up to 1.0 and floors to 1). It cannot matter here: reaching it needs a price
 * near $0.005, and GREATEST(1, ...) makes both answers 1 regardless.
 */

/**
 * usdToGold(value_usd) — market value of one card in gold.
 * `usd <= 0 ? 0 : Math.max(1, Math.round(usd * 100))`
 */
export const MARKET_GOLD_SQL = `
	CASE WHEN value_usd > 0
	     THEN GREATEST(1, FLOOR(value_usd * 100 + 0.5))::bigint
	     ELSE 0::bigint
	END`;

/**
 * cardSellGold(value_usd) — what the shop pays, at the 0.85 vendor spread.
 * `market <= 0 ? 0 : Math.max(1, Math.round(market * 0.85))`
 *
 * Note the nesting: the spread is applied to the ALREADY-ROUNDED market gold, not
 * to the raw USD. Collapsing it to `usd * 85` would be off by one on many prices.
 */
export const SELL_GOLD_SQL = `
	CASE WHEN value_usd > 0
	     THEN GREATEST(1, FLOOR(GREATEST(1, FLOOR(value_usd * 100 + 0.5)) * 0.85 + 0.5))::bigint
	     ELSE 0::bigint
	END`;

/** Total market value of a user's collection, in gold. */
export const COLLECTION_VALUE_SQL = `
	SELECT COALESCE(SUM(${MARKET_GOLD_SQL}), 0)::bigint AS gold
	  FROM collections WHERE user_id = $1`;

/** Total sell-back value of a user's collection, in gold. */
export const COLLECTION_SELL_VALUE_SQL = `
	SELECT COALESCE(SUM(${SELL_GOLD_SQL}), 0)::bigint AS gold
	  FROM collections WHERE user_id = $1`;
