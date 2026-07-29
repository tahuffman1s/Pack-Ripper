/**
 * Fallback collation for sets MTGJSON has no booster data for — in practice a
 * release too new for MTGJSON's last build.
 *
 * Rather than invent a slot structure, this borrows the REAL structure of the
 * nearest comparable set that does have data: same product type, same Scryfall
 * set type, closest release date. A brand-new 2026 expansion therefore collates
 * with the actual sheet layout of the most recent Play Booster set — correct
 * pack size, correct slot mix, correct foil and bonus-sheet rates — with only
 * the card pool substituted.
 *
 * The structure is data; only the substitution is inference.
 */

import { getAllSets } from './scryfall.js';
import { getCollation, cardSlotKind, slotTier, labelFor } from './collation.js';
import { VARIANT_PREFERENCE, isExcludedVariant } from '../packs.js';

const MAX_CANDIDATES = 8; // bound the network cost of the search
const memo = new Map();

function variantIn(slice, packTypeId) {
	if (!slice?.variants) return null;
	for (const key of VARIANT_PREFERENCE[packTypeId] || []) {
		if (slice.variants[key] && !isExcludedVariant(key)) return key;
	}
	return null;
}

/**
 * Find the closest set (by release date, same set type where possible) that has
 * real collation for this product.
 * @returns {Promise<{slice:object, variantKey:string, from:string}|null>}
 */
export async function nearestCollation(setCode, packTypeId, released, setType) {
	const key = `${setCode}:${packTypeId}`;
	if (memo.has(key)) return memo.get(key);

	const all = await getAllSets();
	const target = released ? Date.parse(released) : Date.now();

	const candidates = all
		.filter((s) => !s.digital && s.code !== setCode && (s.cardCount || 0) >= 60)
		.map((s) => ({
			...s,
			dist: Math.abs((s.released ? Date.parse(s.released) : 0) - target),
			sameType: s.type === setType ? 0 : 1
		}))
		// Same set type first, then nearest release date.
		.sort((a, b) => a.sameType - b.sameType || a.dist - b.dist)
		.slice(0, MAX_CANDIDATES * 3);

	let found = null;
	let tried = 0;
	for (const c of candidates) {
		if (tried >= MAX_CANDIDATES) break;
		tried++;
		let slice;
		try {
			slice = await getCollation(c.code);
		} catch {
			continue;
		}
		if (!slice) continue;
		const variantKey = variantIn(slice, packTypeId);
		if (!variantKey) continue;
		found = { slice, variantKey, from: c.code };
		break;
	}

	memo.set(key, found);
	return found;
}

/**
 * Expand a `fixed` sheet — a preconstructed deck, taken in full — into one slot
 * per kind, counted by print weight.
 *
 * A Jumpstart theme deck is a fixed sheet of twenty specific cards, seven of
 * them basic lands. Classified as a whole that sheet reads "wildcard", so
 * borrowing it as a single twenty-card wildcard slot is exactly how a
 * substituted Jumpstart pack ends up with twenty spells and no land at all.
 * Expanded, the borrowed structure keeps the donor deck's real
 * land/common/uncommon/rare mix.
 */
function fixedSlots(sheet, facts) {
	const counts = new Map();
	let mythic = 0;
	let rareish = 0;
	for (const [uuid, w] of Object.entries(sheet.cards)) {
		const fact = facts[uuid];
		const kind = cardSlotKind(fact);
		counts.set(kind, (counts.get(kind) || 0) + w);
		if (kind === 'rare') {
			rareish += w;
			if (fact?.r === 'mythic') mythic += w;
		}
	}
	return [...counts].map(([kind, count]) => ({
		kind,
		label: labelFor(kind, sheet.foil),
		tier: slotTier(kind, sheet.foil),
		foil: !!sheet.foil,
		count,
		mythicShare: kind === 'rare' && rareish > 0 ? mythic / rareish : 0
	}));
}

/**
 * Reduce a real variant to a reusable shape: a weighted list of configurations,
 * each a list of {kind, count, foil} slots. Card identities are dropped; only
 * the structure survives.
 */
export function structureOf(slice, variantKey) {
	const v = slice.variants[variantKey];
	if (!v) return null;
	return {
		total: v.boostersTotalWeight,
		configs: v.boosters.map((cfg) => ({
			weight: cfg.weight,
			slots: Object.entries(cfg.contents).flatMap(([sheetName, count]) => {
				const sheet = v.sheets[sheetName];
				if (sheet?.fixed) return fixedSlots(sheet, slice.cards);
				return [
					{
						kind: sheet?.kind || 'wildcard',
						label: sheet?.label || 'Card',
						tier: sheet?.tier ?? 1,
						foil: !!sheet?.foil,
						count,
						// The real mythic share of this sheet, so a substituted pool
						// keeps the donor set's actual rare:mythic ratio.
						mythicShare: mythicShareOf(sheet, slice.cards)
					}
				];
			})
		}))
	};
}

function mythicShareOf(sheet, facts) {
	if (!sheet) return 0;
	let mythic = 0;
	let rareish = 0;
	for (const [uuid, w] of Object.entries(sheet.cards)) {
		const r = facts[uuid]?.r;
		if (r === 'mythic') mythic += w;
		if (r === 'mythic' || r === 'rare') rareish += w;
	}
	return rareish > 0 ? mythic / rareish : 0;
}

/** Pick one configuration from a structure, by weight. */
export function pickStructureConfig(structure, rng) {
	let r = rng() * structure.total;
	for (const cfg of structure.configs) {
		r -= cfg.weight;
		if (r < 0) return cfg;
	}
	return structure.configs[structure.configs.length - 1];
}
