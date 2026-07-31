/**
 * The schema, as a string rather than a .sql file next to it.
 *
 * The runtime image contains build/ and nothing else — no src/, no node_modules —
 * because adapter-node bundles the whole server. A schema.sql read from disk at
 * boot would work in dev and fail in production, which is the worst shape a
 * deployment bug can have. As a module it is bundled with everything else, and it
 * is still importable by plain node for scripts/import-json-db.js.
 */

export const SCHEMA_SQL = `
-- PackRipper schema.
--
-- Applied on every boot by initDb() in db.js. Everything is IF NOT EXISTS, so it
-- is the whole migration story: starting a container against an empty database
-- creates it, and starting against a populated one is a no-op.
--
-- The shape is relational where being relational buys something and jsonb where
-- it does not, which is a deliberate line rather than a compromise:
--
--   * A column exists for anything the app filters, sorts, aggregates or
--     constrains on. Those are the reasons to have a column.
--   * A 'jsonb' blob holds records the app only ever reads and writes whole —
--     the ~30 stats counters, a blackjack shoe, the tail of a card's print
--     record. Splitting those into columns would add joins and migrations to
--     serve queries nothing makes.
--
-- Timestamps are 'bigint' epoch milliseconds, not 'timestamptz', because that is
-- what the app already stores and passes to the client. db.js parses int8 as a
-- JS number; see the note there about why that is safe for these magnitudes.

CREATE TABLE IF NOT EXISTS users (
	id            text PRIMARY KEY,
	username      text NOT NULL,
	-- Lowercased, and the UNIQUE that replaces the old 'usernames' index map.
	-- Two people racing to register the same name used to be settled by whoever
	-- flushed last; now the loser gets a constraint violation.
	username_key  text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	salt          text NOT NULL,
	created_at    bigint NOT NULL,
	admin         boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS sessions (
	token      text PRIMARY KEY,
	user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS wallets (
	user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	-- CHECK, not just an app-level guard. Every path that spends already tests the
	-- balance first and reports a friendly error, so this never fires in normal
	-- play; it is here so that a future bug in one of those tests aborts a
	-- transaction instead of quietly leaving a player with negative gold.
	gold    bigint NOT NULL DEFAULT 0 CHECK (gold >= 0)
);

-- One row per unopened pack. Previously an array element inside a per-user blob,
-- which is why buying a case and opening a box both had to be written as a single
-- whole-database flush.
CREATE TABLE IF NOT EXISTS inventory (
	id           text PRIMARY KEY,
	user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	set_code     text NOT NULL,
	pack_type_id text NOT NULL,
	acquired_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_user_idx ON inventory (user_id);
-- Mass-open and sell-back both select by (set, product) within one vault.
CREATE INDEX IF NOT EXISTS inventory_user_product_idx
	ON inventory (user_id, set_code, pack_type_id);

-- One row per card instance. A stored instance is a snapshot of a print at the
-- moment it was pulled — including its price — so it is intentionally
-- denormalised and is never reconciled against Scryfall afterwards.
--
-- The columns are the ones something actually uses: user_id and acquired_at to
-- load and order a collection, value_usd to total and sort it, set_code for the
-- filter chips, name/rarity/foil for display and sorting. 'card' carries the rest
-- of the print record (colours, mana cost, type line, images, slot and sheet
-- provenance, treatments) which only ever moves in and out as a unit.
CREATE TABLE IF NOT EXISTS collections (
	uid         text PRIMARY KEY,
	user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	scryfall_id text,
	name        text NOT NULL,
	set_code    text NOT NULL,
	rarity      text,
	foil        boolean NOT NULL DEFAULT false,
	-- double precision, not numeric: pg hands numeric back as a string, and every
	-- consumer of this treats it as a JS number on the way into cardMarketGold().
	-- A two-decimal USD price is exact in a double, so nothing is lost.
	value_usd   double precision NOT NULL DEFAULT 0,
	serial      integer,
	serial_of   integer,
	acquired_at bigint NOT NULL,
	sold        boolean NOT NULL DEFAULT false,
	card        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS collections_user_idx ON collections (user_id);
CREATE INDEX IF NOT EXISTS collections_user_acquired_idx
	ON collections (user_id, acquired_at DESC);
CREATE INDEX IF NOT EXISTS collections_user_set_idx ON collections (user_id, set_code);

-- A grab-bag of counters plus bestPull/slotBest/bySet. Always read and written as
-- one object for one player, and it gains a field whenever a game mode does, so a
-- column per counter would be a migration per feature for no query benefit.
CREATE TABLE IF NOT EXISTS stats (
	user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	data    jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Recent rip summaries, newest first, capped per user by the app.
CREATE TABLE IF NOT EXISTS openings (
	id           text PRIMARY KEY,
	user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	at           bigint NOT NULL,
	set_code     text NOT NULL,
	set_name     text,
	pack_type_id text NOT NULL,
	card_count   integer NOT NULL,
	value_gold   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS openings_user_at_idx ON openings (user_id, at DESC);

-- The serial ledger, and the biggest thing this schema buys.
--
-- A serialized card is a physical object with a finite print run: The One Ring
-- 001/001 can be pulled exactly once, ever. That used to be enforced by reading a
-- map, picking a free number and hoping no concurrent opening picked the same
-- one. It is now a primary key, so the database refuses the duplicate outright.
--
-- Deliberately NOT scoped to a user and NOT cascade-deleted: releasing #137/250
-- back into the pool because its owner's account went away would let a second one
-- exist.
CREATE TABLE IF NOT EXISTS serials (
	scryfall_id text NOT NULL,
	n           integer NOT NULL,
	issued_at   bigint NOT NULL,
	PRIMARY KEY (scryfall_id, n)
);

-- A table in play: shoe, dealer, hands, phase. The shoe is a 312-element array
-- that is drawn from and written back whole, so it stays a blob.
CREATE TABLE IF NOT EXISTS blackjack (
	user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	state   jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS free_spins (
	user_id   text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	remaining integer NOT NULL CHECK (remaining > 0),
	line_bet  integer NOT NULL,
	lines     integer NOT NULL
);

-- Server-wide configuration an admin can change without a redeploy. One row per
-- setting, value as jsonb so a setting can be a number, a flag or an object
-- without a migration. Deliberately tiny: a setting belongs here only when the
-- alternative is an environment variable and a container restart.
CREATE TABLE IF NOT EXISTS settings (
	key   text PRIMARY KEY,
	value jsonb NOT NULL,
	at    bigint NOT NULL
);

-- Store sales. A row is a rule, not a price: it says "20% off Collector Boosters"
-- or "buy two get one free on everything", and the price the store quotes is
-- derived from whichever active rule is the best deal for that product.
--
-- Scope is two nullable columns rather than a pattern language: null means "any",
-- so (null, null) is a site-wide sale and ('tmp', 'draft') is one product. The
-- window is nullable at both ends too — a sale with no end runs until it is
-- switched off.
CREATE TABLE IF NOT EXISTS sales (
	id         text PRIMARY KEY,
	created_at bigint NOT NULL,
	created_by text,
	starts_at  bigint,
	ends_at    bigint,
	-- 'percent' takes a cut off the price; 'bogo' leaves the price alone and puts
	-- extra packs in the bag.
	kind       text NOT NULL CHECK (kind IN ('percent', 'bogo')),
	percent    integer CHECK (percent > 0 AND percent < 100),
	buy_qty    integer CHECK (buy_qty > 0),
	get_qty    integer CHECK (get_qty > 0),
	set_code   text,
	pack_type  text,
	label      text,
	enabled    boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS sales_enabled_idx ON sales (enabled);

-- Server-wide announcements: the grail pulls and jackpots everyone gets told
-- about. Capped by the app, newest first.
--
-- The player's name is denormalised into the row and there is no foreign key,
-- for the same reason the audit log has none: "Travis pulled The One Ring 3/50"
-- is still the thing you want on the board after Travis deletes their account,
-- and an announcement is a historical fact rather than a view of live data.
CREATE TABLE IF NOT EXISTS announcements (
	id       text PRIMARY KEY,
	at       bigint NOT NULL,
	kind     text NOT NULL,
	username text NOT NULL,
	headline text NOT NULL,
	detail   text,
	gold     bigint,
	image    text
);
CREATE INDEX IF NOT EXISTS announcements_at_idx ON announcements (at DESC);

-- Audit trail. Not cascade-deleted from users either: "who deleted that account"
-- is exactly the entry you still want after the account is gone, so the actor and
-- target are recorded as plain text rather than as references.
CREATE TABLE IF NOT EXISTS admin_log (
	id     text PRIMARY KEY,
	at     bigint NOT NULL,
	actor  text,
	via    text,
	action text NOT NULL,
	target text,
	detail text
);
CREATE INDEX IF NOT EXISTS admin_log_at_idx ON admin_log (at DESC);
`;
