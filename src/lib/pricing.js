import { PACK_TYPES } from './packs.js';
import { usdToGold } from './economy.js';

/**
 * Real-world-ish pack pricing.
 *
 * Sealed Magic product is priced at MSRP when in print, but out-of-print packs
 * appreciate on the secondary market — a 25-year-old booster costs far more than
 * its original $3. We model that with:
 *   price = MSRP × vintage(age) × hype(popularity)
 * so the gold cost of a pack tracks what it would actually cost you today.
 *
 * The gold conversion is fixed at 100 gold = $1 (see economy.js), so every price
 * has a transparent USD equivalent shown in the UI.
 */

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Out-of-print appreciation. Flat for ~2 years, then ~8%/yr, capped at 15×. */
export function vintageMultiplier(released, nowMs = Date.now()) {
	if (!released) return 1;
	const age = (nowMs - Date.parse(released)) / YEAR_MS;
	if (age <= 2) return 1;
	return Math.min(15, Math.pow(1.08, age - 2));
}

/**
 * Vintage sealed premium: how far above the value of its singles an old pack
 * actually trades. A sealed 1994 booster is a collectible in its own right, not
 * just a bag of cards, and the gap widens with age.
 *
 * Fitted from 49 paired observations — every pre-2006 set with both a live
 * TCGplayer sealed price and an exactly-computed pack EV (see
 * `node scripts/measure-sealed-premium.mjs`, which re-derives these):
 *
 *   ratio = 0.511 * 1.0720^age     R2 = 0.273
 *   observed  min 1.34x   median 3.44x   mean 3.92x   max 21.23x
 *   by decade 1990s 3.93x   2000s 2.64x
 *
 * R2 is low because individual sets vary enormously with print run and
 * desirability, so this is a central estimate, not a per-set prediction. It is
 * clamped to the observed range rather than extrapolated.
 */
const PREMIUM_BASE = 0.511;
const PREMIUM_PER_YEAR = 1.072;
const PREMIUM_MIN = 1;
const PREMIUM_MAX = 12;

export function sealedPremium(released, nowMs = Date.now()) {
	if (!released) return PREMIUM_MIN;
	const age = (nowMs - Date.parse(released)) / YEAR_MS;
	if (!(age > 0)) return PREMIUM_MIN;
	const raw = PREMIUM_BASE * Math.pow(PREMIUM_PER_YEAR, age);
	return Math.min(PREMIUM_MAX, Math.max(PREMIUM_MIN, raw));
}

/** Popular / marquee sets command a premium while in print. */
function hypeMultiplier(set) {
	return set?.featured ? 1.3 : 1;
}

export function packPriceUsd(set, packTypeId, nowMs = Date.now()) {
	const t = PACK_TYPES[packTypeId];
	if (!t) return 0;
	return t.msrp * vintageMultiplier(set?.released, nowMs) * hypeMultiplier(set);
}

export function boxPriceUsd(set, packTypeId, nowMs = Date.now()) {
	const t = PACK_TYPES[packTypeId];
	if (!t) return 0;
	const base = t.boxMsrp ?? t.msrp * t.boxSize * 0.85;
	return base * vintageMultiplier(set?.released, nowMs) * hypeMultiplier(set);
}

export function packPriceGold(set, packTypeId, nowMs = Date.now()) {
	return usdToGold(packPriceUsd(set, packTypeId, nowMs));
}

export function boxPriceGold(set, packTypeId, nowMs = Date.now()) {
	return usdToGold(boxPriceUsd(set, packTypeId, nowMs));
}
