import { cardMarketGold, cardSellGold } from './economy.js';

export const RARITY = {
	mythic: { label: 'Mythic', text: 'text-orange-400', badge: 'badge-error', ring: 'rarity-glow-mythic', order: 4 },
	rare: { label: 'Rare', text: 'text-amber-300', badge: 'badge-warning', ring: 'rarity-glow-rare', order: 3 },
	uncommon: { label: 'Uncommon', text: 'text-slate-300', badge: 'badge-ghost', ring: '', order: 2 },
	common: { label: 'Common', text: 'text-base-content/70', badge: 'badge-ghost', ring: '', order: 1 },
	art: { label: 'Art Card', text: 'text-secondary', badge: 'badge-secondary', ring: '', order: 0 },
	token: { label: 'Token', text: 'text-base-content/50', badge: 'badge-ghost', ring: '', order: 0 },
	special: { label: 'Special', text: 'text-secondary', badge: 'badge-secondary', ring: '', order: 0 }
};

export function rarityInfo(rarity) {
	return RARITY[rarity] || RARITY.common;
}

/** Pick an image URL for a card, defaulting to a placeholder-safe field. */
export function cardImage(card, size = 'normal') {
	return card?.images?.[size] || card?.images?.normal || card?.images?.small || null;
}

export function marketGold(card) {
	return cardMarketGold(card?.valueUsd ?? 0);
}

export function sellGold(card) {
	return cardSellGold(card?.valueUsd ?? 0);
}

// ── Treatments ─────────────────────────────────────────────────
// "Booster Fun": the borderless / showcase / extended-art / special-foil
// printings that ride in the same slots as the plain versions. These are a real
// part of pack odds — 24% of the cards an MKM Play Booster can contain are
// treatment printings — so they get first-class display.

/** Ordered most-to-least exciting; the first match is the headline chip. */
const TREATMENT_RULES = [
	{ id: 'serialized', test: (c) => (c.promoTypes || []).includes('serialized') },
	{ id: 'textured', test: (c) => (c.promoTypes || []).includes('texturedfoil') },
	{ id: 'surge', test: (c) => (c.promoTypes || []).includes('surgefoil') },
	{ id: 'galaxy', test: (c) => (c.promoTypes || []).includes('galaxyfoil') },
	{ id: 'halo', test: (c) => (c.promoTypes || []).includes('halofoil') },
	{ id: 'confetti', test: (c) => (c.promoTypes || []).includes('confettifoil') },
	{ id: 'oilslick', test: (c) => (c.promoTypes || []).includes('oilslick') },
	{ id: 'rainbow', test: (c) => (c.promoTypes || []).some((t) => /rainbow/.test(t)) },
	{ id: 'compleat', test: (c) => (c.promoTypes || []).includes('stepandcompleat') },
	{ id: 'concept', test: (c) => (c.promoTypes || []).includes('concept') },
	{ id: 'borderless', test: (c) => c.borderColor === 'borderless' },
	{ id: 'showcase', test: (c) => (c.frameEffects || []).includes('showcase') },
	{ id: 'extended', test: (c) => (c.frameEffects || []).includes('extendedart') },
	// `retro` is stamped server-side: the 1997 frame only counts as a treatment
	// when it appears in a set printed after the modern frame arrived (8ED, 2003).
	{ id: 'retro', test: (c) => !!c.retro || (c.promoTypes || []).includes('retro') },
	{ id: 'fullart', test: (c) => !!c.fullArt },
	{ id: 'etched', test: (c) => (c.finishes || []).includes('etched') },
	{ id: 'textless', test: (c) => !!c.textless }
];

export const TREATMENTS = {
	serialized: { label: 'SERIALIZED', cls: 'bg-gradient-to-r from-amber-300 via-fuchsia-400 to-cyan-300 text-black' },
	textured: { label: 'TEXTURED', cls: 'bg-gradient-to-r from-violet-400 to-amber-300 text-black' },
	surge: { label: 'SURGE FOIL', cls: 'bg-gradient-to-r from-sky-400 to-emerald-300 text-black' },
	galaxy: { label: 'GALAXY FOIL', cls: 'bg-gradient-to-r from-indigo-500 to-fuchsia-400 text-white' },
	halo: { label: 'HALO FOIL', cls: 'bg-gradient-to-r from-cyan-300 to-lime-300 text-black' },
	confetti: { label: 'CONFETTI', cls: 'bg-gradient-to-r from-pink-400 to-yellow-300 text-black' },
	oilslick: { label: 'OIL SLICK', cls: 'bg-gradient-to-r from-slate-700 to-fuchsia-700 text-white' },
	rainbow: { label: 'RAINBOW FOIL', cls: 'bg-gradient-to-r from-red-400 via-emerald-300 to-indigo-400 text-black' },
	compleat: { label: 'COMPLEAT', cls: 'bg-gradient-to-r from-emerald-600 to-slate-800 text-white' },
	concept: { label: 'CONCEPT ART', cls: 'bg-gradient-to-r from-amber-400 to-rose-400 text-black' },
	borderless: { label: 'BORDERLESS', cls: 'bg-violet-500 text-white' },
	showcase: { label: 'SHOWCASE', cls: 'bg-fuchsia-500 text-white' },
	extended: { label: 'EXTENDED ART', cls: 'bg-indigo-500 text-white' },
	retro: { label: 'RETRO FRAME', cls: 'bg-amber-700 text-white' },
	fullart: { label: 'FULL ART', cls: 'bg-teal-500 text-white' },
	etched: { label: 'ETCHED', cls: 'bg-gradient-to-r from-amber-200 to-amber-500 text-black' },
	textless: { label: 'TEXTLESS', cls: 'bg-slate-600 text-white' }
};

/** All treatments a card carries, most notable first. */
export function treatmentsOf(card) {
	if (!card) return [];
	const out = [];
	for (const rule of TREATMENT_RULES) {
		try {
			if (rule.test(card)) out.push(rule.id);
		} catch {
			/* a missing field just means "not that treatment" */
		}
	}
	return out;
}

export function treatmentInfo(id) {
	return TREATMENTS[id] || null;
}

/** The single chip worth showing in a tight space. */
export function topTreatment(card) {
	const t = card?.treatments?.length ? card.treatments : treatmentsOf(card);
	return t.length ? t[0] : null;
}

export function finishLabel(card) {
	if (card?.finish === 'etched') return 'ETCHED';
	if (card?.finish === 'foil' || card?.foil) return 'FOIL';
	return null;
}

/**
 * Cards stored before collation existed have no treatments/slot/finish fields.
 * Fill them in on read so old and new collection rows render identically.
 */
export function normalizeInstance(c) {
	if (!c) return c;
	return {
		...c,
		finish: c.finish ?? (c.foil ? 'foil' : 'nonfoil'),
		treatments: c.treatments ?? [],
		slotLabel: c.slotLabel ?? null,
		serial: c.serial ?? null,
		serialOf: c.serialOf ?? null
	};
}

/** Accent name -> hex for three.js / gradients. */
export const ACCENT_HEX = {
	primary: '#c084fc',
	secondary: '#22d3ee',
	info: '#38bdf8',
	accent: '#fbbf24',
	success: '#34d399'
};
