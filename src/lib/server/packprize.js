/**
 * Turning a slot prize BUDGET into a real booster pack.
 *
 * The Mana Machine does not award named products — it awards a budget, a multiple
 * of the stake (see the note at the top of lib/slots.js). This module spends it:
 * it picks a pack the store actually sells for at or below the budget, and the
 * remainder is paid in gold as change.
 *
 * That "and change" is what makes the published return exact rather than
 * approximate. A pack prize is worth `price + (budget - price)` = the budget,
 * whatever pack gets picked and whether one gets picked at all — a budget too
 * small for anything on the shelf is simply paid in gold. So the pack track
 * contributes exactly its stated share of RTP.
 *
 * "Price" here means what the COUNTER PAYS for the pack, not its market value.
 * Those are the same number most of the time and diverge during a sale, and using
 * the buy-back figure is what keeps the identity above true either way: the player
 * can turn the prize into exactly that much gold, so budget in equals value out.
 *
 * ── What is excluded, and why ───────────────────────────────────
 *
 * Vintage product whose price floor has not been computed yet is left out
 * entirely. An Alpha booster is priced at $43 by the MSRP-times-age heuristic and
 * at $21,179 once the real print sheets have been summed (see packvalue.js), and
 * a prize picked against the cold number and sold back against the warm one is a
 * money printer. game.js solves this on the buy path by awaiting the floor before
 * charging; a slot spin cannot await a network fetch inside its transaction, so it
 * declines to offer those packs instead.
 */

import { randomInt } from 'node:crypto';
import { storeSets } from './registry.js';
import { packSellGold } from './game.js';
import { isVintage, lastKnownPackEv } from './packvalue.js';

/**
 * Catalogue rebuild interval.
 *
 * Prices come from in-process caches that warm in the background, so the
 * catalogue genuinely changes during the first minutes of a process's life and
 * hardly ever afterwards. A minute is short enough that a warming floor shows up
 * promptly and long enough that a spin is never the thing that walks 186 sets.
 *
 * Sale rules move buy-back prices too, and they are cached for fifteen seconds, so
 * a sale that starts mid-session is reflected here within a minute. The caller
 * (spin) loads them before opening its transaction.
 */
const TTL_MS = 60_000;

let catalogue = { at: 0, items: [] };

/**
 * Every pack the machine may award, cheapest first.
 * `[{ setCode, setName, packTypeId, priceGold }]`
 */
function build() {
	const items = [];
	for (const set of storeSets()) {
		if (set.unreleased) continue;
		for (const packTypeId of set.packTypes || []) {
			// See the header: a cold vintage floor is an arbitrage, not a bargain.
			if (isVintage(set.released) && lastKnownPackEv(set.code, packTypeId) == null) continue;
			// The SELL price, not the market price. A prize is worth its budget only if
			// what the player can realise for it equals what the budget said, and while a
			// sale is on the counter pays the sale price (see packSellGold). Outside a
			// sale the two are the same number, so this changes nothing in the normal case
			// and stops a sale quietly shaving value off every pack prize.
			const priceGold = packSellGold(set, packTypeId);
			if (!(priceGold > 0)) continue;
			items.push({
				setCode: set.code,
				setName: set.name,
				packTypeId,
				priceGold
			});
		}
	}
	items.sort((a, b) => a.priceGold - b.priceGold);
	return items;
}

function items() {
	const now = Date.now();
	if (now - catalogue.at > TTL_MS) catalogue = { at: now, items: build() };
	return catalogue.items;
}

/** Cheapest pack the machine can award at all, for the paytable's small print. */
export function cheapestPrizeGold() {
	const list = items();
	return list.length ? list[0].priceGold : 0;
}

/**
 * Spend a budget.
 *
 * Among the packs at or below the budget, the choice is uniform over those in the
 * TOP portion of the affordable range — because "you won a pack worth about your
 * stake" should hand over something close to the stake, not the cheapest pack in
 * Magic's history every time. The band widens if it is empty and, failing that,
 * falls back to the dearest thing affordable.
 *
 * @param {number} budgetGold
 * @returns {{pack:{setCode:string,setName:string,packTypeId:string,priceGold:number}|null, changeGold:number}}
 */
export function pickPackPrize(budgetGold) {
	const budget = Math.floor(Number(budgetGold) || 0);
	if (budget <= 0) return { pack: null, changeGold: 0 };

	const list = items();
	const affordable = list.filter((p) => p.priceGold <= budget);
	if (!affordable.length) {
		// Nothing on the shelf fits — the whole prize is paid in gold.
		return { pack: null, changeGold: budget };
	}

	// Widening bands, best first. 0.75 is generous enough that the prize usually
	// looks like the budget; the fallbacks exist so a sparse price range (a budget
	// that lands in a gap between a $9 booster and a $40 collector pack) still
	// produces a pack rather than silently paying gold.
	let pool = null;
	for (const floor of [0.75, 0.4, 0]) {
		const band = affordable.filter((p) => p.priceGold >= budget * floor);
		if (band.length) {
			pool = band;
			break;
		}
	}
	const chosen = pool[randomInt(pool.length)];

	return { pack: chosen, changeGold: budget - chosen.priceGold };
}
