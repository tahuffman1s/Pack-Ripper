/**
 * Pack products.
 *
 * Slot structures are NOT defined here any more. Real collation comes from
 * MTGJSON's per-set print-sheet weights (see server/collation.js) — the actual
 * reverse-engineered sheets, so a Play Booster's rare slot is 6:1 rare:mythic
 * because the sheet says so, not because a constant here says so.
 *
 * What lives here is product metadata (names, MSRP, box sizes) plus the mapping
 * from PackRipper's five product ids to MTGJSON variant keys, and a deliberately
 * small set of era templates used only when no collation data exists at all.
 */

/** @type {Record<string, {id:string,name:string,short:string,cardCount:number,msrp:number,boxMsrp:number,boxSize:number,accent:string,blurb:string}>} */
export const PACK_TYPES = {
	draft: {
		id: 'draft',
		name: 'Draft Booster',
		short: 'Draft',
		cardCount: 15,
		msrp: 3.99,
		boxMsrp: 110,
		boxSize: 36,
		accent: 'primary',
		blurb: '15 cards. The classic booster — 1 rare/mythic, 3 uncommons, commons, a land, and a chance at a foil.'
	},
	set: {
		id: 'set',
		name: 'Set Booster',
		short: 'Set',
		cardCount: 14,
		msrp: 4.99,
		boxMsrp: 130,
		boxSize: 30,
		accent: 'secondary',
		blurb: '12 cards + art card. Guaranteed rare/mythic, a guaranteed foil, wildcards and a shot at The List.'
	},
	play: {
		id: 'play',
		name: 'Play Booster',
		short: 'Play',
		cardCount: 14,
		msrp: 6.49,
		boxMsrp: 150,
		boxSize: 36,
		accent: 'info',
		blurb: '14 cards. The modern standard — commons, uncommons, a rare/mythic, two wildcards, a foil and The List.'
	},
	jumpstart: {
		id: 'jumpstart',
		name: 'Jumpstart Booster',
		short: 'Jumpstart',
		cardCount: 20,
		msrp: 5.99,
		boxMsrp: 90,
		boxSize: 24,
		accent: 'success',
		blurb: '20 cards built around a theme — shuffle two together for an instant deck.'
	},
	mystery: {
		id: 'mystery',
		name: 'Mystery Booster',
		short: 'Mystery',
		cardCount: 15,
		msrp: 6.99,
		boxMsrp: 160,
		boxSize: 24,
		accent: 'secondary',
		blurb:
			'15 cards, one drawn from each print sheet — anything from Magic\'s history, every card on a sheet equally likely.'
	},
	collector: {
		id: 'collector',
		name: 'Collector Booster',
		short: 'Collector',
		cardCount: 15,
		msrp: 26.99,
		boxMsrp: 280,
		boxSize: 12,
		accent: 'accent',
		blurb: '15 premium cards — nearly all foil, mythic-rich, packed with the chase treatments.'
	}
};

export const PACK_TYPE_ORDER = ['draft', 'play', 'set', 'jumpstart', 'mystery', 'collector'];

/** Box price = per-pack price * size, with a bulk discount. */
export const BOX_DISCOUNT = 0.9;

export function packTypeById(id) {
	return PACK_TYPES[id] || null;
}

/**
 * PackRipper product id -> MTGJSON `data.booster` variant keys, best first.
 * Pre-2018 sets almost all use `default` for their one and only booster.
 */
export const VARIANT_PREFERENCE = {
	draft: ['draft', 'default'],
	play: ['play', 'default'],
	set: ['set'],
	jumpstart: ['jumpstart', 'default'],
	// MTGJSON files the retail Mystery Booster under `draft`; the convention
	// editions (playtest card in the last slot) are separate variants.
	mystery: ['draft', 'convention-2021', 'convention'],
	collector: ['collector']
};

/**
 * Variants that exist in the data but are not one of our five products:
 * digital-only, sample/promotional packs, kits and non-booster oddities.
 * This takes precedence over VARIANT_PREFERENCE — no key appears in both.
 */
export const EXCLUDED_VARIANTS = new Set([
	'arena', 'play-arena', 'draft-arena', 'set-arena',
	'collector-sample', 'draft-sample', 'set-sample', 'sample',
	'prerelease', 'welcome', 'tournament', 'fat-pack', 'starter',
	'six', 'three', 'two', 'topper', 'box-topper',
	'theme-w', 'theme-u', 'theme-b', 'theme-r', 'theme-g', 'theme-m', 'theme-c',
	'planeswalker-deck', 'challenger-deck', 'jumpstart-front-card'
]);

export function isExcludedVariant(name) {
	if (EXCLUDED_VARIANTS.has(name)) return true;
	return /arena|sample|topper|^theme-|deck$/.test(name);
}

/**
 * Sets that appear in Scryfall's booster-eligible types but never shipped as a
 * sealed booster product: bonus sheets that ride inside other sets' packs,
 * foreign-language reprints of an existing set, and playtest-card inserts.
 * Offering a "Draft Booster of The List" would be inventing a product.
 */
export const NOT_A_SEALED_PRODUCT = new Set([
	'plst', 'ulst', // The List
	'big',          // The Big Score (rides in OTJ)
	'tsb',          // Time Spiral Timeshifted (rides in TSP)
	'spg',          // Special Guests (rides in modern Play/Collector boosters)
	'fbb', '4bb', 'bchr', // foreign-language reprints of 4ED/Chronicles
	'cmb1', 'cmb2', 'unk', 'und' // Mystery Booster playtest inserts / boxed variants
]);

export function isSealedProduct(code) {
	return !NOT_A_SEALED_PRODUCT.has(String(code || '').toLowerCase());
}

/**
 * Mystery Boosters are their own product line. They were never sold as Draft,
 * Play or Collector Boosters, and their collation is nothing like those — every
 * card on a 121-card print sheet is equally likely, and a pack takes exactly one
 * card from each sheet.
 */
export const MYSTERY_SETS = new Set(['mb1', 'mb2', 'fmb1']);

export function isMysterySet(code) {
	return MYSTERY_SETS.has(String(code || '').toLowerCase());
}

// ── Era templates ──────────────────────────────────────────────
// Used ONLY when no MTGJSON collation exists — in practice a set released after
// MTGJSON's last build. Packs built this way are stamped estimated:true.
// Dated boundaries, so a 1997 pack never contains a treatment invented in 2019.

const MYTHIC_START = Date.parse('2008-10-03'); // Shards of Alara
const FOIL_START = Date.parse('1999-02-15');   // Urza's Legacy
const PLAY_START = Date.parse('2024-02-09');   // Murders at Karlov Manor

/**
 * A minimal, honest slot template. Rare:mythic is 6:1 — the ratio Wizards
 * states as a design invariant and which MKM/DSK/FDN published tables confirm
 * to the decimal (85.7% / 14.3%).
 * @returns {{size:number, mythicChance:number, foilChance:number, slots:{kind:string,count:number}[]}}
 */
export function eraTemplate(releasedAt, packTypeId) {
	const rel = releasedAt ? Date.parse(releasedAt) : Date.now();
	const mythicChance = rel >= MYTHIC_START ? 1 / 7 : 0;
	const foilChance = rel >= FOIL_START ? 0.33 : 0;

	if (packTypeId === 'collector') {
		return {
			size: 15,
			mythicChance: Math.max(mythicChance, 1 / 7),
			foilChance: 1,
			slots: [
				{ kind: 'land', count: 1 },
				{ kind: 'common', count: 5 },
				{ kind: 'uncommon', count: 4 },
				{ kind: 'rare', count: 5 }
			]
		};
	}
	if (packTypeId === 'jumpstart') {
		return {
			size: 20,
			mythicChance,
			foilChance,
			slots: [
				{ kind: 'land', count: 3 },
				{ kind: 'common', count: 12 },
				{ kind: 'uncommon', count: 3 },
				{ kind: 'rare', count: 2 }
			]
		};
	}
	if (packTypeId === 'play' || rel >= PLAY_START) {
		return {
			size: 14,
			mythicChance,
			foilChance: 1, // Play Boosters guarantee a traditional foil
			slots: [
				{ kind: 'land', count: 1 },
				{ kind: 'common', count: 6 },
				{ kind: 'uncommon', count: 3 },
				{ kind: 'rare', count: 1 },
				{ kind: 'wildcard', count: 2 },
				{ kind: 'bonus', count: 1 }
			]
		};
	}
	if (packTypeId === 'set') {
		return {
			size: 13,
			mythicChance,
			foilChance: 1,
			slots: [
				{ kind: 'land', count: 1 },
				{ kind: 'common', count: 5 },
				{ kind: 'uncommon', count: 2 },
				{ kind: 'rare', count: 1 },
				{ kind: 'wildcard', count: 4 }
			]
		};
	}
	// Classic Draft Booster.
	return {
		size: 15,
		mythicChance,
		foilChance,
		slots: [
			{ kind: 'land', count: 1 },
			{ kind: 'common', count: 10 },
			{ kind: 'uncommon', count: 3 },
			{ kind: 'rare', count: 1 }
		]
	};
}

/** Display label for a synthesized (non-MTGJSON) slot. */
export const SLOT_LABELS = {
	land: 'Land',
	common: 'Common',
	uncommon: 'Uncommon',
	rare: 'Rare / Mythic',
	wildcard: 'Wildcard',
	bonus: 'The List / Bonus Sheet',
	special: 'Special'
};
