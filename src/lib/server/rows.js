/**
 * Row ↔ object mapping for the tables whose records the app passes around whole.
 *
 * This is its own module, with no imports, so that the one-shot importer can use
 * exactly the same mapping as the running app without dragging in the registry,
 * the TCGplayer client and the collation cache that game.js needs. If a card
 * round-trips correctly here it round-trips correctly there.
 */

/**
 * Card-instance fields that get their own column, because something filters,
 * sorts, totals or displays a list by them. Everything else on a stored instance
 * (colours, mana cost, type line, images, slot and sheet provenance, treatments)
 * lives in the `card` jsonb, because it only ever moves as a unit.
 *
 * Keep this in step with the collections table in schema.js: a field added here
 * and not there is silently dropped on write.
 */
const PROMOTED = new Set([
	'uid',
	'id',
	'name',
	'set',
	'rarity',
	'foil',
	'valueUsd',
	'serial',
	'serialOf',
	'acquiredAt',
	'sold'
]);

/** Column list for an INSERT into collections, in the order cardToValues returns. */
export const COLLECTION_COLUMNS = [
	'uid',
	'user_id',
	'scryfall_id',
	'name',
	'set_code',
	'rarity',
	'foil',
	'value_usd',
	'serial',
	'serial_of',
	'acquired_at',
	'sold',
	'card'
];

/** One card instance as a parameter tuple for COLLECTION_COLUMNS. */
export function cardToValues(userId, c) {
	const rest = {};
	for (const key of Object.keys(c)) {
		if (!PROMOTED.has(key)) rest[key] = c[key];
	}
	return [
		c.uid,
		userId,
		c.id ?? null,
		c.name ?? '',
		c.set ?? '',
		c.rarity ?? null,
		!!c.foil,
		Number(c.valueUsd) || 0,
		c.serial ?? null,
		c.serialOf ?? null,
		c.acquiredAt ?? Date.now(),
		!!c.sold,
		JSON.stringify(rest)
	];
}

/** A collections row back into the card instance the app stores. */
export function cardFromRow(r) {
	return {
		...r.card,
		uid: r.uid,
		id: r.scryfall_id,
		name: r.name,
		set: r.set_code,
		rarity: r.rarity,
		foil: r.foil,
		valueUsd: r.value_usd,
		serial: r.serial,
		serialOf: r.serial_of,
		acquiredAt: r.acquired_at,
		sold: r.sold
	};
}

/** An inventory row back into an unopened-pack record. */
export function packFromRow(r) {
	return {
		id: r.id,
		setCode: r.set_code,
		packTypeId: r.pack_type_id,
		acquiredAt: r.acquired_at
	};
}

/** An openings row back into a rip summary. */
export function openingFromRow(r) {
	return {
		id: r.id,
		at: r.at,
		setCode: r.set_code,
		setName: r.set_name,
		packTypeId: r.pack_type_id,
		cardCount: r.card_count,
		valueGold: r.value_gold
	};
}

/**
 * Build a multi-row VALUES clause and its flat parameter list.
 *
 * Used for banking a ripped box in one statement. Chunked by the caller rather
 * than sent as one giant statement: Postgres allows 65535 bound parameters per
 * query, and a 216-pack case is roughly 3,000 cards at 13 columns each, which is
 * close enough to that ceiling to be worth not finding out about in production.
 */
export function valuesClause(rowCount, columnCount, startAt = 1) {
	const tuples = [];
	let n = startAt;
	for (let i = 0; i < rowCount; i++) {
		const placeholders = [];
		for (let c = 0; c < columnCount; c++) placeholders.push(`$${n++}`);
		tuples.push(`(${placeholders.join(', ')})`);
	}
	return tuples.join(', ');
}
