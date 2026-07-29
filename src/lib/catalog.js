/**
 * Booster-product rules — pure functions applied to Scryfall set metadata.
 *
 * The full store line-up is built dynamically from Scryfall's /sets endpoint
 * (see server/registry.js). These helpers decide which booster products a given
 * set offers, following real Magic history, and add a bit of curated flavour.
 */

import { isSealedProduct, isMysterySet } from './packs.js';

// Historical product-era boundaries (release dates).
const COLLECTOR_START = Date.parse('2019-10-01'); // Throne of Eldraine — first Collector Boosters
const SET_START = Date.parse('2020-09-01'); // Zendikar Rising — first Set Boosters
const PLAY_START = Date.parse('2024-02-01'); // Murders at Karlov Manor — Play Boosters replace Draft & Set

// Scryfall set_types that actually shipped in booster packs.
const BOOSTER_SET_TYPES = new Set(['core', 'expansion', 'masters', 'draft_innovation', 'funny']);

function releasedMs(set) {
	return set?.released ? Date.parse(set.released) : 0;
}

/**
 * Codes of sets that shipped Jumpstart Boosters *alongside* their main product —
 * Dominaria United, The Brothers' War, Phyrexia, March of the Machine, Avatar,
 * Marvel Super Heroes. Their Jumpstart cards live in the parent set, so there is
 * no standalone Jumpstart set to find them under.
 *
 * Read off Scryfall rather than hand-kept: Wizards prints a "<set> Jumpstart
 * Front Cards" set for exactly those releases, so its presence is the product's
 * fingerprint. Skipped when the Jumpstart release stands alone and is already in
 * the store under its own code — Foundations Jumpstart is J25, not part of FDN.
 * @param {{code:string,name:string,digital?:boolean}[]} sets
 * @returns {Set<string>}
 */
export function jumpstartParentCodes(sets) {
	const byName = new Map((sets || []).map((s) => [s.name, s]));
	const parents = new Set();
	for (const s of sets || []) {
		const m = /^(.*) Jumpstart Front Cards$/.exec(s.name || '');
		if (!m) continue;
		const parent = byName.get(m[1]);
		if (!parent || parent.digital) continue;
		if (byName.has(`${m[1]} Jumpstart`)) continue; // standalone release
		parents.add(parent.code);
	}
	return parents;
}

/**
 * Which booster products this set offers, in proper display order
 * (the "opening" product first, then premium).
 * @param {object} set
 * @param {Set<string>} [jumpstartParents] from `jumpstartParentCodes`
 * @returns {string[]}
 */
export function boosterTypesForSet(set, jumpstartParents) {
	if (!set || set.digital) return [];
	if (!BOOSTER_SET_TYPES.has(set.type)) return [];

	const rel = releasedMs(set);
	const types = [];

	// Mystery Boosters are a product line of their own — no Draft, Play or
	// Collector Booster of a Mystery Booster set has ever existed.
	if (isMysterySet(set.code)) return ['mystery'];

	// Standalone Jumpstart releases are their own product line.
	if (/jumpstart/i.test(set.name) || ['jmp', 'j22', 'j25', 'jsdo'].includes(set.code)) {
		types.push('jumpstart');
		if (rel >= COLLECTOR_START) types.push('collector');
		return types;
	}

	// Base "opening" product: Play (2024+) or Draft (everything before).
	if (rel >= PLAY_START) types.push('play');
	else types.push('draft');

	// Set Boosters: premier sets only, 2020–2024.
	if (rel >= SET_START && rel < PLAY_START && (set.type === 'core' || set.type === 'expansion')) {
		types.push('set');
	}

	// Jumpstart Boosters as a companion product to the set's own boosters.
	if (jumpstartParents?.has(set.code)) types.push('jumpstart');

	// Collector Boosters: premier + masters + draft-innovation, 2019+.
	if (rel >= COLLECTOR_START && ['core', 'expansion', 'masters', 'draft_innovation'].includes(set.type)) {
		types.push('collector');
	}

	return types;
}

/** Whether a set belongs in the store (has products and a real card pool). */
export function storeEligible(set) {
	if (!set || set.digital) return false;
	if (!BOOSTER_SET_TYPES.has(set.type)) return false;
	if ((set.cardCount || 0) < 60) return false; // skip tiny promo-ish sets
	// Bonus sheets and foreign reprints look like booster sets to Scryfall but
	// were never sold as sealed product — there is no "Draft Booster of The List".
	if (!isSealedProduct(set.code)) return false;
	return boosterTypesForSet(set).length > 0;
}

// A few marquee sets we surface on the home page.
export const FEATURED_CODES = new Set([
	'fin', 'mh3', 'ltr', 'neo', 'one', 'otj', 'blb', 'dsk', 'znr', 'khm', 'war', 'eld', 'mkm', 'fdn'
]);

export function isFeatured(code) {
	return FEATURED_CODES.has(String(code || '').toLowerCase());
}

// Curated flavour tags for well-known sets; otherwise a type-based label.
const TAGS = {
	fin: 'Crossover', ltr: 'The One Ring', mh3: 'High Power', mh2: 'High Power', mh1: 'High Power',
	neo: 'Cyberpunk', one: 'Compleat', otj: 'Wild West', blb: 'Critters', dsk: 'Horror',
	znr: 'Modern DFCs', khm: 'Vikings', war: 'Planeswalkers', eld: 'Fairytales', mkm: 'Whodunnit',
	fdn: 'Evergreen', ktk: 'Fetchlands', isd: 'Gothic Horror', rav: 'Guilds', inv: 'Multicolor',
	tmp: 'Classic', usg: 'Power', dmu: 'Legends', mom: 'War', woe: 'Fairytales'
};

const TYPE_LABEL = {
	core: 'Core Set',
	expansion: 'Expansion',
	masters: 'Masters',
	draft_innovation: 'Special',
	funny: 'Un-set'
};

export function tagFor(set) {
	return TAGS[set?.code] || TYPE_LABEL[set?.type] || 'Set';
}
