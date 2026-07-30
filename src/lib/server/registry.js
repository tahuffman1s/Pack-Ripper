import { getAllSets } from './scryfall.js';
import {
	boosterTypesForSet,
	jumpstartParentCodes,
	marketCandidate,
	storeEligible,
	tagFor,
	isFeatured
} from '../catalog.js';
import { initSealed, warmSealed, getSealed } from './tcgplayer.js';
import { warmVintageEv } from './packvalue.js';

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
	const boosterTypes = boosterTypesForSet(s, jumpstartParents, getSealed(s.code));
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
			initSealed();

			// Sets Scryfall does not type as booster sets, but which may still have
			// sold boosters — the standalone Universes Beyond Commander releases and
			// the Portal-era starter sets. Whether they belong in the store at all
			// depends on what TCGplayer lists for them, so those ~55 entries are
			// resolved up front rather than left to the background warm below.
			// Measured at 0.55s cold and nothing at all once the disk cache is warm.
			try {
				await warmSealed(sets.filter(marketCandidate));
			} catch (e) {
				console.error('sealed lookup for non-booster set types failed:', e);
			}

			// Needs the whole list: a set's Jumpstart Booster is evidenced by a
			// *companion* set, not by anything on the set itself.
			const jumpstartParents = jumpstartParentCodes(sets);
			const idx = new Map();
			for (const s of sets) idx.set(s.code, annotate(s, jumpstartParents));
			index = idx;
			storeList = [...idx.values()]
				.filter(storeEligible)
				.sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));

			// Warm the rest of the sealed prices in the background (doesn't block),
			// then the vintage price floors — in that order, because a live sealed
			// price outranks the floor, so a set that gets one needs no EV at all.
			//
			// The floors have to be warmed by something other than a page visit. They
			// are what stops a 1993 booster being priced by the MSRP heuristic, which
			// puts an Alpha pack at $43 next to singles worth thousands, and .cache is
			// was deliberately not mounted on the old Azure host — so every revision started cold.
			warmSealed(storeList)
				.catch((e) => console.error('warmSealed failed:', e))
				.then(() => warmVintageEv(storeList))
				.catch((e) => console.error('warmVintageEv failed:', e));
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
