import { getAllSets } from './scryfall.js';
import { boosterTypesForSet, jumpstartParentCodes, storeEligible, tagFor, isFeatured } from '../catalog.js';
import { initSealed, warmSealed } from './tcgplayer.js';

/**
 * In-memory registry of every Magic set, annotated with the booster products it
 * offers. Built once (from the disk-cached /sets response) and looked up
 * synchronously everywhere else. `ensureSets()` is awaited in hooks.server.js so
 * the index is always populated before any load/action runs.
 */

let index = null; // code -> entry
let storeList = null; // eligible sets, newest first
let loading = null;

function annotate(s, jumpstartParents) {
	const boosterTypes = boosterTypesForSet(s, jumpstartParents);
	const releaseMs = s.released ? Date.parse(s.released) : 0;
	return {
		...s,
		year: s.released ? Number(String(s.released).slice(0, 4)) : null,
		unreleased: releaseMs > Date.now(),
		boosterTypes,
		packTypes: boosterTypes, // alias used by product/pricing helpers
		tag: tagFor(s),
		featured: isFeatured(s.code)
	};
}

export async function ensureSets() {
	if (index) return;
	if (!loading) {
		loading = (async () => {
			const sets = await getAllSets();
				// Needs the whole list: a set's Jumpstart Booster is evidenced by a
				// *companion* set, not by anything on the set itself.
				const jumpstartParents = jumpstartParentCodes(sets);
				const idx = new Map();
				for (const s of sets) idx.set(s.code, annotate(s, jumpstartParents));
				index = idx;
			storeList = [...idx.values()]
				.filter(storeEligible)
				.sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));

			// Load cached TCGplayer sealed prices and warm any missing ones in
			// the background (doesn't block requests).
			initSealed();
			warmSealed(storeList).catch((e) => console.error('warmSealed failed:', e));
		})();
	}
	await loading;
}

export function setEntry(code) {
	return index?.get(String(code || '').toLowerCase()) || null;
}

export function storeSets() {
	return storeList || [];
}

export function featuredSets() {
	return (storeList || []).filter((s) => s.featured);
}
