/**
 * Store sales.
 *
 * A sale is a RULE, not a price. "20% off Collector Boosters" and "buy two get
 * one free on everything" are both rows in `sales`, and the price the store
 * quotes for a product is derived by asking which active rule is the best deal
 * for it. Two kinds:
 *
 *   percent  takes a cut off the price. Applies to packs and boxes alike.
 *   bogo     leaves the price alone and puts extra packs in the bag: buy N, get M
 *            free. Only meaningful on packs and boxes as UNITS, so buying three
 *            boxes on "buy 2 get 1" gets a fourth box's worth of packs.
 *
 * ── The arbitrage, and why sell-back moves with the sale ────────
 *
 * Unopened packs sell back to the store at full market value, which is a
 * deliberate and long-standing rule — a sealed pack is worth what a sealed pack
 * is worth. A discount breaks it: buy at 50% off, sell back at 100%, repeat, and
 * the store is a gold printer with no upper bound.
 *
 * So the counter pays the SALE price too. `packSellGold()` is the market price
 * capped by whatever the store is currently charging for the same product,
 * including the effective per-pack price of a BOGO. That closes the loop exactly
 * — you can never sell a pack back for more than you could buy it for — and it is
 * how a real shop behaves: nobody buys back stock above their own shelf price.
 * The visible consequence is that a sale temporarily lowers what a hoard is worth,
 * which is fair warning and is said out loud in the store.
 */

import { query, makeId } from './db.js';

/** How many sale rows are kept. Expired ones are pruned when a new one is created. */
const KEEP = 100;

/**
 * Cache of the active rules.
 *
 * Every price the store quotes consults this, and the store index quotes ~186 of
 * them in one page load, so it cannot be a query per product. Sales change by
 * hand, so a short TTL is plenty and a write clears it outright.
 */
const TTL_MS = 15_000;
let cached = { at: 0, rules: [] };

function rowToSale(r) {
	return {
		id: r.id,
		createdAt: r.created_at,
		createdBy: r.created_by,
		startsAt: r.starts_at,
		endsAt: r.ends_at,
		kind: r.kind,
		percent: r.percent,
		buyQty: r.buy_qty,
		getQty: r.get_qty,
		setCode: r.set_code,
		packType: r.pack_type,
		label: r.label,
		enabled: r.enabled
	};
}

export function invalidateSales() {
	cached = { at: 0, rules: [] };
}

/** Every sale row, newest first — for the admin panel. */
export async function listSales() {
	const { rows } = await query('SELECT * FROM sales ORDER BY created_at DESC LIMIT $1', [KEEP]);
	const now = Date.now();
	return rows.map((r) => {
		const s = rowToSale(r);
		return {
			...s,
			live: isLive(s, now),
			expired: s.endsAt != null && s.endsAt <= now,
			pending: s.startsAt != null && s.startsAt > now
		};
	});
}

function isLive(sale, now) {
	if (!sale.enabled) return false;
	if (sale.startsAt != null && sale.startsAt > now) return false;
	if (sale.endsAt != null && sale.endsAt <= now) return false;
	return true;
}

/** The rules in force right now, cached. */
async function liveRules() {
	const now = Date.now();
	if (now - cached.at < TTL_MS) return cached.rules;
	let rules = [];
	try {
		const { rows } = await query('SELECT * FROM sales WHERE enabled ORDER BY created_at');
		rules = rows.map(rowToSale).filter((s) => isLive(s, now));
	} catch (e) {
		// No sale is the safe failure: prices fall back to full market value, which
		// is what they were before this table existed.
		console.error('sales: could not read rules —', e.message);
		rules = [];
	}
	cached = { at: now, rules };
	return rules;
}

/**
 * Load the rules into the synchronous cache.
 *
 * Pricing is synchronous everywhere else in this app — `packPriceGold` reads
 * in-process caches and nothing awaits — and making it async would ripple into
 * every store page, the rescue net-worth sum and the slot prize picker. So the
 * rules are fetched here, once per request that needs them, and read
 * synchronously after that. Call it before quoting prices.
 */
export async function loadSales() {
	await liveRules();
}

/**
 * The rules currently loaded. Synchronous, and empty until loadSales() has run
 * once in this process — a page that quotes prices without loading them first
 * simply shows full price, which is the safe direction to be wrong in.
 *
 * A cache up to TTL_MS stale is deliberate: it means a sale can start or end up
 * to fifteen seconds late. Nothing depends on the boundary being exact, and
 * `buy()` re-reads the rules for itself before charging.
 */
function rulesNow() {
	return cached.rules;
}

function matches(sale, setCode, packTypeId) {
	if (sale.setCode && sale.setCode !== setCode) return false;
	if (sale.packType && sale.packType !== packTypeId) return false;
	return true;
}

/**
 * How much of the full price a sale leaves you paying, per pack — the number that
 * makes two different kinds of deal comparable.
 *
 *   30% off        -> 0.70
 *   buy 2 get 1    -> 2/3 = 0.667, so it is the better deal
 */
function effectiveRate(sale) {
	if (sale.kind === 'percent') return 1 - (sale.percent || 0) / 100;
	if (sale.kind === 'bogo') {
		const buy = sale.buyQty || 1;
		const get = sale.getQty || 1;
		return buy / (buy + get);
	}
	return 1;
}

/**
 * The best sale on offer for one product, or null.
 * Synchronous — see loadSales().
 */
export function saleFor(setCode, packTypeId) {
	let best = null;
	let bestRate = 1;
	for (const s of rulesNow()) {
		if (!matches(s, setCode, packTypeId)) continue;
		const rate = effectiveRate(s);
		if (rate < bestRate) {
			bestRate = rate;
			best = s;
		}
	}
	return best;
}

/** Every live sale that could apply to a set, for the store's badges. */
export function salesForSet(setCode) {
	return rulesNow().filter((s) => !s.setCode || s.setCode === setCode);
}

/** Any sale at all running right now, for the store banner. */
export function anySaleLive() {
	return rulesNow().length > 0;
}

/**
 * What one unit costs after the best applicable sale.
 * A BOGO does not change the unit price — it changes how many you get.
 */
export function discountedPrice(fullPrice, sale) {
	if (!sale || sale.kind !== 'percent') return fullPrice;
	// Floor, so a discount is never rounded away to nothing and never rounds up
	// against the player. A 1-gold product on a 50% sale is free; nothing costs
	// 1 gold.
	return Math.max(0, Math.floor(fullPrice * (1 - (sale.percent || 0) / 100)));
}

/**
 * Free units that come with an order of `units`, under a BOGO.
 * Buying 5 on "buy 2 get 1" is two complete deals plus a spare: 2 free.
 */
export function bonusUnits(units, sale) {
	if (!sale || sale.kind !== 'bogo') return 0;
	const buy = sale.buyQty || 1;
	const get = sale.getQty || 1;
	return Math.floor(units / buy) * get;
}

/**
 * A short human phrase for a sale, for badges and toasts. Uses the stored label
 * when an admin wrote one.
 */
export function saleLabel(sale) {
	if (!sale) return '';
	if (sale.label) return sale.label;
	if (sale.kind === 'percent') return `${sale.percent}% off`;
	const buy = sale.buyQty || 1;
	const get = sale.getQty || 1;
	if (buy === 1 && get === 1) return 'Buy one get one free';
	return `Buy ${buy} get ${get} free`;
}

/** A sale row as the client needs it. */
export function saleForClient(sale) {
	if (!sale) return null;
	return {
		id: sale.id,
		kind: sale.kind,
		percent: sale.percent ?? null,
		buyQty: sale.buyQty ?? null,
		getQty: sale.getQty ?? null,
		label: saleLabel(sale),
		endsAt: sale.endsAt ?? null,
		rate: effectiveRate(sale)
	};
}

// ── Writes ─────────────────────────────────────────────────────

/**
 * Create a sale. Validated here rather than at the call site because both the
 * admin panel and the CLI reach it through the same action.
 */
export async function createSale({
	kind,
	percent,
	buyQty,
	getQty,
	setCode,
	packType,
	label,
	startsAt,
	endsAt,
	createdBy
}) {
	kind = String(kind || '').toLowerCase();
	if (kind !== 'percent' && kind !== 'bogo') {
		throw new Error('A sale is either "percent" or "bogo".');
	}

	let pct = null;
	let buy = null;
	let get = null;
	if (kind === 'percent') {
		pct = Math.round(Number(percent));
		if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
			throw new Error('A percentage sale must be between 1% and 99%.');
		}
	} else {
		buy = Math.floor(Number(buyQty ?? 1));
		get = Math.floor(Number(getQty ?? 1));
		if (!(buy >= 1) || !(get >= 1)) throw new Error('Buy and get quantities must be at least 1.');
		if (buy > 100 || get > 100) throw new Error('Keep buy/get quantities under 100.');
	}

	const starts = startsAt == null || startsAt === '' ? null : Number(startsAt);
	const ends = endsAt == null || endsAt === '' ? null : Number(endsAt);
	if (starts != null && !Number.isFinite(starts)) throw new Error('Invalid start time.');
	if (ends != null && !Number.isFinite(ends)) throw new Error('Invalid end time.');
	if (starts != null && ends != null && ends <= starts) {
		throw new Error('The sale would end before it started.');
	}

	const id = makeId();
	await query(
		`INSERT INTO sales
		   (id, created_at, created_by, starts_at, ends_at, kind, percent, buy_qty, get_qty,
		    set_code, pack_type, label, enabled)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
		[
			id,
			Date.now(),
			createdBy || null,
			starts,
			ends,
			kind,
			pct,
			buy,
			get,
			setCode ? String(setCode).toLowerCase() : null,
			packType || null,
			label ? String(label).slice(0, 60) : null
		]
	);

	// Keep the table small. Only rows that can never apply again are dropped, so a
	// sale that is merely switched off stays visible in the panel.
	await query(
		`DELETE FROM sales
		  WHERE ends_at IS NOT NULL AND ends_at < $1
		    AND id NOT IN (SELECT id FROM sales ORDER BY created_at DESC LIMIT $2)`,
		[Date.now(), KEEP]
	);

	invalidateSales();
	const { rows } = await query('SELECT * FROM sales WHERE id = $1', [id]);
	return rowToSale(rows[0]);
}

/** Switch a sale off (or back on). */
export async function setSaleEnabled(id, enabled) {
	const { rowCount } = await query('UPDATE sales SET enabled = $2 WHERE id = $1', [
		String(id),
		!!enabled
	]);
	invalidateSales();
	return rowCount > 0;
}

/** Delete a sale outright. */
export async function deleteSale(id) {
	const { rowCount } = await query('DELETE FROM sales WHERE id = $1', [String(id)]);
	invalidateSales();
	return rowCount > 0;
}

/** Turn every sale off. The "end all sales now" button. */
export async function endAllSales() {
	const { rowCount } = await query('UPDATE sales SET enabled = false WHERE enabled');
	invalidateSales();
	return rowCount;
}
