/**
 * Economy / currency rules. Shared between client and server (no secrets here).
 *
 * The in-game currency is "gold". Gold is free — every account starts with a
 * grant and can never truly run out (the store is a sink, selling is a faucet).
 *
 * Conversion anchor: 100 gold == $1.00 USD. This is used both to price packs
 * (from their real-world MSRP) and to value cards (from Scryfall USD prices).
 */

/**
 * The DEFAULT opening balance.
 *
 * The live figure is a row in the `settings` table that an admin can change
 * without a redeploy, and this is what a database with no such row returns — so a
 * fresh install behaves exactly as it did before that table existed. Read it
 * through `startingGold()` in server/settings.js on any path that actually hands
 * gold out; this constant is only the fallback and the "back to stock" value.
 */
export const STARTING_GOLD = 100_000;

/** 100 gold per US dollar. */
export const GOLD_PER_USD = 100;

/**
 * When you sell a card you get a fraction of its market value — a vendor spread,
 * exactly like a real buylist. This keeps pack EV honest (slightly negative,
 * like reality) so chasing value feels earned.
 */
export const SELL_RATE = 0.85;

/** Convert a USD amount to whole gold. */
export function usdToGold(usd) {
	if (!usd || usd <= 0) return 0;
	return Math.max(1, Math.round(usd * GOLD_PER_USD));
}

/** Market (buy-it-now) value of a card in gold, from its USD price. */
export function cardMarketGold(usd) {
	return usdToGold(usd);
}

/** What the shop pays you when you sell a card (rounded, min 1 if worth >0). */
export function cardSellGold(usd) {
	const market = usdToGold(usd);
	if (market <= 0) return 0;
	return Math.max(1, Math.round(market * SELL_RATE));
}

/** Format a gold amount with thousands separators. */
export function formatGold(n) {
	return Math.round(n || 0).toLocaleString('en-US');
}

/** Format a USD number for display. */
export function formatUsd(n) {
	return (n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
