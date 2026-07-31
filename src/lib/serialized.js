/**
 * Serialized cards — the numbered chase pulls.
 *
 * Everything that CAN come from an API does:
 *
 *   which cards are serialized   Scryfall  `set:X is:serialized`  (promo_types)
 *   how often they appear        MTGJSON   serialized sheets, where modelled
 *   print run, where modelled    MTGJSON   sheet weight (LTR: weight x100)
 *
 * Six sets put serialized cards on real MTGJSON sheets — BRO/BRR, RVR, MOM,
 * MUL, LTR and LTC — so for those, both the card list AND the rate are read
 * straight out of the collation data and nothing here is needed. LTR's rate
 * computes to 0.065030%, matching the published figure exactly.
 *
 * For the remaining sets Scryfall knows the cards exist but MTGJSON does not
 * place them on a sheet. Two numbers are then genuinely unavailable from any
 * API — no endpoint anywhere publishes them:
 *
 *   1. the per-pack pull rate  (Wizards only ever says "less than 1%")
 *   2. the print run           (confirmed absent from every Scryfall field)
 *
 * Rather than invent them, both are DERIVED from the sets MTGJSON does model:
 * see observedSerializedStats() in server/serializedStats.js. Cards produced
 * that way are flagged estimated:true and labelled as such in the UI.
 */

/**
 * Products whose MTGJSON sheet weights encode the print run.
 *
 * Tales of Middle-earth is the informative case. Its three serialized Sol Rings
 * were printed in runs of 300, 700 and 900, and their sheet weights are 3, 9 and
 * 7 — the run divided by 100. The weight IS the run, so there is no need to guess
 * from card names.
 *
 * Both codes are here because the cards and the packs disagree about which set
 * they belong to: the Sol Rings ride LTR Collector Booster sheets but MTGJSON
 * files them under LTC, the Commander companion set. Matching on 'ltr' alone
 * meant the weight rule never fired for the three cards it was written for.
 */
const RUN_IN_SHEET_WEIGHT = new Set(['ltr', 'ltc']);

/**
 * Print run for a serialized card.
 *
 * `setCode` is the product the sheet belongs to, since that is what qualifies
 * `sheetWeight`. `fallbackRun` is the observed median for everything else — no
 * other set publishes a run anywhere, and a serialized card with no run cannot
 * be given a number at all, so callers that want one must supply it. The One
 * Ring is a genuine 1-of-1 and sits alone on its own weight-1 sheet.
 */
export function serialRunFor(setCode, card, sheetWeight, fallbackRun) {
	if (/^The One Ring$/i.test(card?.name || '')) return 1;
	const code = String(setCode || '').toLowerCase();
	if (RUN_IN_SHEET_WEIGHT.has(code) && sheetWeight > 0) return sheetWeight * 100;
	return fallbackRun || null;
}

/** Whether a resolved card is a serialized printing. */
export function isSerializedCard(card) {
	return (card?.promoTypes || []).includes('serialized');
}

/**
 * A serialized card is a physical object existing in exactly `of` copies, so
 * two players must never both own #137/250. Draws from what is unclaimed.
 * @returns {number|null} the serial, or null if the whole run is gone
 */
export function pickSerial(issued, of, rng = Math.random) {
	if (!of || of < 1) return null;
	const taken = new Set(issued || []);
	if (taken.size >= of) return null;
	if (taken.size < of * 0.5) {
		for (let i = 0; i < 50; i++) {
			const n = 1 + Math.floor(rng() * of);
			if (!taken.has(n)) return n;
		}
	}
	const free = [];
	for (let n = 1; n <= of; n++) if (!taken.has(n)) free.push(n);
	if (!free.length) return null;
	return free[Math.floor(rng() * free.length)];
}

/**
 * Scryfall rarely carries a usable price for serialized printings, so the
 * rarest pull in the game would otherwise show $0, sort last in the reveal and
 * never register as a best pull. Floor it by scarcity instead.
 */
export function serializedFloorUsd(of, base = 0) {
	if (!of || of < 1) return base;
	const floor = of <= 1 ? 100000 : of <= 100 ? 2000 : of <= 300 ? 900 : of <= 500 ? 500 : 250;
	return Math.max(base || 0, floor);
}
