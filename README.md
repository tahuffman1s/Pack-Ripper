# ⚡ PackRipper

A mobile-first **Magic: The Gathering pack-opening simulator** built with SvelteKit. Buy
sealed product with free in-game gold, rip open booster packs in 3D, swipe through your
pulls, build a collection, and sell cards back for gold. Real cards, real art, real prices —
all sourced live from [Scryfall](https://scryfall.com).

It's a simulator: the currency is free and no real money is ever involved.

## Features

- **Login system** — username/password accounts with hashed passwords (scrypt) and session
  cookies — username and password only, nothing else asked for. Every new account starts with
  **100,000 free gold**.
- **Store** — every booster-eligible MTG set from 1993 to today, each offering the booster
  products it actually shipped with:
  - **Draft Boosters** (classic 15-card packs, pre-2024)
  - **Set Boosters** (2020–2023)
  - **Play Boosters** (2024+, the modern standard)
  - **Collector Boosters** (premium, near-all-foil, mythic-rich)
  - Buy single packs **or full booster boxes** at a bulk discount. Packs-per-box comes from
    MTGJSON's sealed-product data, so it is right per set. Across all 868 sets, 49 of 51 Collector
    Booster boxes are 12 packs; the only genuine exceptions are Double Masters 2022 and Commander
    Masters at 4. Products with "Case" in the name are skipped — MTGJSON files some master cases
    under `booster_box`, and counting those as packs made a Collector box claim 24.
- **Real pack collation** — packs are collated from **MTGJSON**'s per-set print sheets: the
  actual reverse-engineered print-run weights Wizards used, per card, not a hand-tuned
  approximation. Everything falls out of that data — the 1-in-7 mythic rate, multi-rare packs,
  The List and Special Guests, foil rates, and every borderless / showcase / extended-art
  treatment at its true frequency. Measured against Wizards' published figures over 200,000
  simulated Murders at Karlov Manor Play Boosters:

  | | PackRipper | Wizards published |
  |---|---|---|
  | Rare/mythic as-fan | 1.4522 | "slightly over 1.4" |
  | Packs with 2+ rares | 39.9% | 41% |
  | Rare-slot mythic share | 14.37% | 14.29% (1 in 7) |
  | Foil land | 20.00% | 20% |

  Run `node scripts/verify-odds.mjs` to re-check. Every era works: Arabian Nights gives real
  8-card packs, Tempest 15, Play Boosters 14, and Collector Boosters come out treatment-dense
  and mythic-rich.
- **Laid out like a real pack** — a collation study of Murders at Karlov Manor Play Boosters
  documents the physical stack, front-facing: *art card/token → basic land → List or Special
  Guest → the guaranteed foil → 1-2 rares → 3-4 uncommons → 6-8 commons*. Cards group by
  **rarity, not by slot** — a wildcard that rolls uncommon physically sits among the uncommons.
  Ripping a real pack turns that stack over, so the reveal runs commons → uncommons → rares →
  foil → bonus card → land → token, which is exactly what you swipe through here. Packs include
  the 15th non-playable card too: a **token** for Draft and Play Boosters, an **art card** for
  Set Boosters, and nothing at all for Collector Boosters or for sets printed before tokens
  existed. Flip `REVEAL_FROM_FRONT` in `server/opener.js` to read the stack the other way.
- **Serialized cards** — the numbered chase pulls. For the six sets MTGJSON models on real
  sheets (BRO, LTR, MOM, MUL, RVR, LTC) the rate comes straight from the data: an LTR Collector
  Booster has a **0.06503%** chance of a serialized Sol Ring, and The One Ring 001/001 is a
  genuine 1-of-1 at **1 in 3,333,333**. Serial numbers are issued from a global ledger, so a
  given `#137/250` can only ever be pulled once.
- **3D pack opening** — packs are rendered and animated with **three.js** (drag to inspect,
  tap to rip), then you **swipe** through each revealed card with a value summary at the end.
- **Currency & economy** — a fixed conversion anchor (100 gold = $1). **Pack and box prices are
  real TCGplayer sealed-market prices** (via tcgcsv.com) — a Tempest booster really costs ~🪙10,040
  ($100), a modern pack ~🪙500. Card values come from live Scryfall USD prices. Sell at an 85%
  buylist rate. Sets without a live listing fall back to an MSRP×vintage estimate (shown with ≈).
- **Mana Machine** — a 2D slot machine: 3 reels × 3 rows, **5 paylines**, and a **free-spin bonus
  round**. Each reel is a strip of 24 physical stops scrolled behind a three-row window in plain
  DOM and CSS; odds come from how often a symbol appears on its reel strip, the same way a mechanical
  slot works — and the same way pack collation works here. Winning cells light up in place and the
  paylines are traced across the window, so the reels *are* the result readout. Because the 3×3
  window is fully determined by the three reel stops, the whole game is solvable exactly:
  `node scripts/verify-slots.mjs` enumerates all 24³ = 13,824 outcomes across every payline and the
  bonus round.

  | | |
  |---|---|
  | Return to player | 94.03% — identical at every bet and line count |
  | Hit rate | 31.9% on 1 line, 81.6% on 5 |
  | Paylines | middle, top, bottom, and both diagonals |
  | Bet | 🪙5–200 per line × 1/3/5 lines (🪙5–1,000 a spin) |
  | Free spins | 3+ 📦 Boosters anywhere → 8 free spins, 1 in 64 |
  | Top line prize | 🪙120,000 |

  ⚡ is wild on any line but never substitutes for 📦, which pays from anywhere on the grid and on
  the total bet. Payouts are multipliers of the stake, so more lines buy more **coverage, not better
  value** — the verifier asserts the RTP is identical at 1, 3 and 5 lines rather than assuming it.
  Free spins are **server state**: they survive a reload, lock in the stake that triggered them, cost
  nothing, and cannot retrigger (which is exactly the model the RTP solver folds in as a ×1.125
  uplift). The spin is rolled server-side with `node:crypto`; stake and line count are the only
  things the client supplies and both are validated against allow-lists, so a crafted negative or
  off-ladder bet cannot mint gold. Debit, roll, credit and bonus bookkeeping happen in one atomic
  mutation, so a spin can never half-apply.
- **Mystery Boosters** are their own product line, not a Draft or Collector Booster with a different
  name. MTGJSON carries their real 121-card print sheets, and a pack takes exactly one card from
  each: white ×2, blue ×2, black ×2, red ×2, green ×2, land/multicolour/colourless, rare-or-mythic,
  playtest, white-border, and a Future Sight-frame card (4.5% foil, 0.8% an Alchemy acorn card).
  Every card on a sheet is equally likely — that is the whole design of the product.
- **Card prices fall back through three sources.** Scryfall's USD comes from TCGplayer, which has no
  listing for much vintage product — 62 of 175 Alpha cards have no `usd`, which is why Ancestral
  Recall used to show as 🪙0. Missing USD is filled from the Cardmarket euro price, converted at a
  rate **derived from the data** (median usd/eur over the cards that have both) rather than a
  hardcoded currency constant. The handful with no listing in either currency — mostly cards Wizards
  withdrew from print, so they genuinely are not traded — take the median price of their own rarity
  in the same set.
- **Vintage sealed is priced from its contents, plus a measured premium.** MSRP × age prices an
  Alpha booster at $43; the singles inside average $4,184. For pre-2006 product with no live
  listing, the exact expected value of the real print sheets acts as a price floor, scaled by the
  **sealed premium** — how far above its singles an old pack actually trades. That multiple is
  measured, not guessed: `node scripts/measure-sealed-premium.mjs` pairs every pre-2006 set having
  both a live TCGplayer price and a computed EV (49 observations) and fits `ratio = 0.511 ×
  1.0720^age`, giving 5.1× at 1993 and 1.0× for anything in print. Alpha lands at $21,175 a pack,
  just above Beta's live $19,645 — the right ordering, which the bare EV floor got backwards.

  A real listing always wins: the estimate is only used when nothing is listed. And the floor is
  deliberately not applied to in-print product, where singles worth more than the pack is normal and
  is exactly why people crack Mystery Boosters.

- **Blackjack** — a full 6-deck table. Dealer stands on soft 17, blackjack pays 3:2, double on any
  two cards including after a split, split up to 4 hands (aces get one card each). Suits are the
  mana colours. **House edge 0.47% with correct play**, and there is a built-in basic-strategy hint
  that runs the exact same table the verifier uses to measure that edge.

  `node scripts/verify-blackjack.mjs` can't enumerate blackjack the way the slot is enumerated, so
  it does three things instead: checks hand evaluation **exhaustively** over all 8,554 distinct
  2–5 card hands (including that a soft hand can never bust on the next card), chi-square tests the
  shuffle for bias, and measures the house edge by simulating basic strategy over hundreds of
  thousands of rounds.

  No insurance — it's a side bet on the dealer holding a ten, paying 2:1 on a shot closer to 9:4, so
  declining is always better; rather than offer a trap the dealer just peeks. The shoe lives on the
  server and is never serialized to the client, the hole card is withheld until legitimately turned
  over, and every move is re-validated against real table state (verified: 0 illegal moves accepted
  out of every hit/stand/double/split tried against hands that didn't allow them).

- **The Bulk Bin** — a failsafe so you can never get stranded. If you have no gold to spend, no
  packs to open and nothing worth selling, a banner offers a rummage through the shop's bulk bin:
  a pile of modest real cards worth roughly 🪙300 at the counter, enough to sell and get moving
  again. Eligibility is computed server-side from total net worth (gold + card buylist value +
  pack buy-back value), so it cannot be claimed while you still have a move. Individual cards are
  value-capped, so the bin never hands out a chase mythic. If card data is unavailable entirely,
  it falls back to plain gold — the failsafe must never itself fail.
- **Collection** — filter (rare+/foil/by set), sort (value/rarity/newest), inspect any card,
  and sell singles or bulk-select for a mass sale.
- **Stats** — packs/boxes opened, cards opened/sold, gold spent/earned, net profit, mythics /
  rares / foils pulled, best pull ever, collection value, and most-opened sets.
- **Admin panel + CLI** — hand out gold and packs, promote admins, reset passwords, delete
  accounts. Same actions from `/admin` in the browser or `./admin.sh` on the host, every one of
  them written to an audit trail. See [Admin](#admin).
- **Mobile-first UI** with DaisyUI on a custom arcane/foil dark theme.

## Tech stack

- **SvelteKit 2 + Svelte 5** (runes)
- **Tailwind CSS 4 + DaisyUI 5**
- **three.js** for the 3D pack
- **MTGJSON** (MIT) for booster collation — fetched lazily per set as a `.json.gz`, gunzipped
  with `node:zlib`, and cached as a ~110 KB slice under `.cache/collation/`
- **Scryfall API** for card data, art, treatments and prices (cached to disk under `.cache/`)
- **PostgreSQL 17** for accounts, wallets, collections, stats and the serial ledger — see
  [The database](#the-database). Still no native dependencies: `pg` is pure JavaScript.

## Running it

The app needs a Postgres to talk to. The quickest one is the container the compose file already
defines:

```bash
npm install
docker compose up -d db                                   # or: ./run.sh up, for the whole stack
export DATABASE_URL=postgres://packripper:packripper@localhost:5432/packripper
npm run dev      # http://localhost:5173
```

The schema is applied on boot — there is no migration step to remember, and pointing the app at an
empty database is all it takes to get a working one.

Then register an account and start ripping. The first pack you open from any given set will
take a few seconds while its card pool is fetched from Scryfall; after that it's cached.

Production build:

```bash
npm run build
npm run start    # serves the node adapter build on PORT (default 3000)
```

## Running in a container

`run.sh` builds the image and runs it on this machine. It drives `podman` or `docker` directly
rather than compose, so it needs no compose provider installed.

```bash
./run.sh               # app on http://localhost:3000
./run.sh down          # stop and remove the container
./run.sh logs          # follow the container's log
./run.sh restart       # keeps .data and .cache
./run.sh pull          # run the image GitHub Actions built, instead of building
./run.sh shell         # a shell inside it
```

Two details worth knowing:

- **The database is a second container**, and its data lives in a named volume rather than a
  bind mount — so `./run.sh down` and `restart` cannot lose it. Only `./run.sh reset` can, and it
  asks first. `.cache` is still bind-mounted; it holds nothing secret and losing it costs a slow
  first minute. Nothing in either is baked into the image.
- **The request origin has to be right.** SvelteKit refuses any POST whose `Origin` header
  disagrees with the origin it believes it is serving, and a mismatch breaks every login and
  purchase while pages keep loading normally. `run.sh` pins `ORIGIN` to
  `http://localhost:PORT`; in Azure it has to be set to the real `https://` hostname.

The runtime image carries 760 KB of `node_modules` — the Postgres driver and its dependencies,
and nothing else. Everything else adapter-node bundles into `build/`. Vite deliberately leaves
packages listed in `dependencies` as external imports rather than bundling them, and enumerating
`pg`'s transitive tree in `vite.config.js` to force it would work today and break silently, in
production only, the next time `pg` gained a package. `--omit=optional` keeps `pg-native` out, so
there is still no native module anywhere.

`docker-compose.yml` does the same thing for anyone who has a compose provider.

## The database

Every account, wallet, collection, pack, stat and issued serial number lives in **PostgreSQL**.
The schema is in `src/lib/server/schema.js` and is applied on every boot; every statement is
`IF NOT EXISTS`, so that is the whole migration story — a fresh volume becomes a working database
and a populated one is untouched.

The shape is relational where being relational buys something and `jsonb` where it does not, which
is a line rather than a compromise. A column exists for anything the app filters, sorts, aggregates
or constrains on. A `jsonb` blob holds records only ever read and written whole: the ~30 stats
counters, a 312-card blackjack shoe, the tail of a card's print record. Splitting those into
columns would add joins and migrations to serve queries nothing makes.

Two things the database now enforces that used to be application logic:

- **A serialized card cannot be printed twice.** `serials` has primary key `(scryfall_id, n)`, so
  The One Ring 001/001 is unique by constraint rather than by a careful read-then-write. The ledger
  is deliberately *not* cascade-deleted with a user — releasing #137/250 back into the pool because
  its owner left would let a second one exist.
- **Deleting an account cannot leave half of one behind.** Sessions, wallet, inventory, collection,
  stats, openings, the blackjack table and free spins are all `ON DELETE CASCADE`.

**Sessions expire in two places, on purpose.** `getUserFromSession` will not honour a token older
than 30 days, and a sweep deletes those rows at boot and every six hours after. Only the first of
those is a security boundary: the cookie's `Max-Age` governs whether a *browser* keeps sending a
token, but a token copied out of one — a shared machine, a stolen backup — is just a string, and
without the age test in the query it would authenticate forever. The sweep is housekeeping, because
rows outlive the cookies that reference them: a browser stops sending an expired token and never
tells the server, so the table would only ever grow. Its timer is `unref()`'d, so it can never be
the reason a process that was ready to exit does not — see the shutdown note under
[Notes & knobs](#notes--knobs).

### Why it stopped being a JSON file

The old design kept everything in memory and rewrote **the entire database** on every mutation.
Not scale — 71 accounts and 3,153 cards is nothing — but three specific costs:

- Write cost grew with the size of the *whole server* rather than the size of the change. One
  blackjack hit rewrote all 71 accounts: ~4 MB, measured at ~20 ms on NVMe and far worse on a
  network share or an SD card.
- About 250 of `db.js`'s 393 lines were defending one file against torn writes, unattached volumes
  and SMB rename semantics. None of those are the application's to survive, and none of that code
  exists now.
- It capped the app at one replica, and made every read-then-write correct only by accident of
  being synchronous.

That last point is the one to understand if you touch this code. The old data layer was
synchronous, which made every read-then-write atomic for free — nothing could interleave between
`if (wallet.gold < cost)` and `wallet.gold -= cost`. Every one of those now has an `await` in the
middle. **So every path that moves money takes a row lock on the wallet first**, via `lockGold()`
in `db.js`, and does its arithmetic after. That is not an optimisation; it is what restores a
guarantee the synchronous version had by accident. Two concurrent buys against a two-pack balance
now buy two packs, not twenty.

Going relational also fixed a race the old code genuinely had: two concurrent opens of the same
pack both found it in the array, both rolled it, and both banked their cards while only one removed
the pack. Openings now `DELETE ... RETURNING` the inventory rows first and bank only the packs whose
row they actually claimed.

### Migrating from `.data/db.json`

Automatic. On boot, if the database has **zero accounts** and a `.data/db.json` exists, it is
imported in one transaction and the file is left untouched. That guard is the whole design: it can
only ever add data to an empty database, never overwrite a populated one, so it is safe to leave
enabled forever rather than being a step someone has to remember exactly once.

Note the guard is the opposite shape to the one the old loader needed. That code had to decide
whether a missing file meant "first boot" or "the volume is not mounted", because it was about to
*write*, and guessing wrong destroyed 71 accounts. Nothing here can destroy anything — the worst
case is that an import does not happen, and the fix is to restart with the file present.

To look before you leap, or to import into a database the app is not running against yet:

```bash
node scripts/import-json-db.js --dry-run    # counts what it would import, connects to nothing
DATABASE_URL=postgres://... node scripts/import-json-db.js
```

Set `IMPORT_LEGACY_JSON=0` to start deliberately empty with the old file still sitting there.

### Two duplicated money rules, and what keeps them honest

`src/lib/server/economySql.js` reimplements `usdToGold()` and `cardSellGold()` in SQL, because
valuing a collection is a `SUM` over a few thousand rows and the layout asks for that total on
*every* page load — shipping every row out to add up one number was the most wasteful thing the old
layer did on a hot path.

A duplicated money rule is only acceptable if something checks it:

```bash
DATABASE_URL=postgres://... node scripts/verify-gold-sql.mjs
```

It runs both implementations over every distinct price in the live database plus a list of awkward
ones, and fails on any disagreement. It has already earned its keep: the first version of the SQL
cast to `numeric` on the reasoning that exact arithmetic could not mis-round, and that cast changed
the value — `1.005::double` is really `1.00499999999999989`, and casting yields the shortest decimal
that round-trips, so the product became exactly `100.5` and rounded *up* where JS rounds down. The
SQL now does the arithmetic in double precision and uses `FLOOR(x + 0.5)`, which is what
`Math.round` is specified to be. If you change `economy.js`, change that file, and run this.

## Admin

There is a panel at **`/admin`** and a CLI at **`./admin.sh`**. Both do the same things — give a
player gold, drop packs into their vault, promote another admin, reset a password, sign someone
out, clear a wedged blackjack hand, delete an account — and both go through one dispatch table in
`src/lib/server/admin.js`, so they cannot drift apart. Every action is appended to an audit trail
that the panel shows at the bottom of the page and `./admin.sh log` prints.

Two environment variables control access. Both are **empty by default, and empty means the door is
off rather than unlocked**:

| Variable | What it does |
|---|---|
| `ADMIN_USERNAMES` | Comma-separated accounts that are admins regardless of the database. The panel appears in their nav; `/admin` is a **404** for everyone else. |
| `ADMIN_TOKEN` | Shared secret for `./admin.sh`. Unset, the CLI cannot authenticate and the panel is the only way in. |

`ADMIN_USERNAMES` is the bootstrap, and it exists because a fresh database has no admins and
nothing in the UI can promote the first one. It applies at sign-in and does not care whether the
account exists yet, so you can set it before registering. Everyone promoted afterwards is flagged
in the database and needs no variable.

### Setting it up

```bash
./admin.sh token                  # generates a value for ADMIN_TOKEN
```

Put both variables where that copy of the app reads its environment — `.env` locally (`run.sh` and
`docker-compose.yml` both pass them through), or the Container App's environment variables in
Azure — then restart. `./run.sh restart` locally; a new revision in the Portal.

### Commands

```bash
./admin.sh help                       # every command
./admin.sh status                     # health, totals, uptime
./admin.sh list                       # every account, richest first
./admin.sh show travis                # one account in full
./admin.sh admin travis               # grant admin (./admin.sh admin travis off revokes)
./admin.sh gold travis 50000          # add gold; a negative amount takes it away
./admin.sh gold travis 1000 --set     # set the balance outright
./admin.sh packs travis fdn play 36   # grant a box of Foundations Play Boosters, free
./admin.sh passwd travis newsecret    # set a password, signing them out everywhere
./admin.sh unstick travis             # clear a wedged blackjack hand / free spins
./admin.sh delete someone --yes       # delete an account and everything on it
./admin.sh log                        # the audit trail
```

It talks to a **running** app over HTTP — `http://127.0.0.1:$PORT` by default, `--url` or
`PACKRIPPER_URL` for anything else, so the Azure copy is administered from here with
`--url https://<hostname>`. `--json` prints raw JSON for piping into `jq`.

### Inside the container

The image puts the same CLI on the `PATH` as **`admin`**, which is the form to use in the Azure
Container App's console, where every character is typed by hand:

```bash
admin list
admin gold travis 50000
```

Or from a host that has the container but no checkout:

```bash
podman exec packripper admin list      # or ./admin.sh list --in-container
```

`admin.sh` itself is deliberately **not** in the image, and could not be: it is a bash script and
the runtime image is Alpine with no bash. It also has nothing to do there — finding `.env` and
choosing between local `node` and `exec` are questions that only exist outside the container. The
one thing it adds inside, a short name, the image provides directly.

`--in-container` is what `./admin.sh` falls back to when this machine has no `node` at all. It
looks for a container called `packripper`; set `PACKRIPPER_CONTAINER` if yours is named something
else. Set `ADMIN_ACTOR` there too — inside the container the OS user is `root`, which makes for a
dull audit trail.

Three details that are deliberate rather than incidental:

- **The CLI talks HTTP, not SQL.** It could connect to Postgres directly now — the old reason it
  could not (the app held everything in memory and would overwrite any outside edit) is gone. It
  still does not, and that is the better answer: it needs no database credentials, it gets the same
  validation as the panel, and every action lands in the same audit log. It is also why the CLI
  needs the app up.
- **`/admin` and `/api/admin` answer 404, not 403,** to anyone who is not an admin. A "forbidden"
  tells whoever guessed the URL that there is something there worth attacking. The panel is linked
  in the nav for admins, so nobody who should be there has to guess.
- **Granted gold is kept out of the player's earned/spent figures.** Folding it into
  `stats.goldEarned` would make their own net-profit number a lie; it lands in the audit trail and
  a separate running total instead. There are guards against locking yourself out, too: you cannot
  revoke your own admin, delete the account you are signed in as, or remove the last admin.

Actions are logged with who did them. A panel action records the admin's username; a CLI action
records `cli:<operator>`, taken from `ADMIN_ACTOR` or the OS user, so a shared host still shows
which person ran the command.

## The image, on GHCR

`.github/workflows/publish-image.yml` builds the runtime image on every push to `main` and
pushes it to this repo's container registry:

```bash
podman pull ghcr.io/tahuffman1s/pack-ripper:latest     # or ./run.sh pull
```

Tags are `latest` (main), `sha-<short>` for every commit, and `v*` for tags. No secrets
involved — the workflow's automatic `GITHUB_TOKEN` can write packages. Two things to know:

- **It is public because the repo is**, and pulls anonymously with no login. If you ever find
  it private — GHCR does not always inherit — flip it under your profile → Packages →
  `pack-ripper` → Package settings → Change visibility.
- **`linux/amd64` and `linux/arm64`**, as one manifest list — `docker pull` resolves to the right
  half on its own. Each is built on a runner of its own architecture (`ubuntu-latest` and
  `ubuntu-24.04-arm`) and merged by digest in a second job, because building arm64 under QEMU
  takes `npm ci` and the vite build from ~3 minutes to ~20. ARM matters because the cheap places
  to run this are ARM — see [Oracle](#hosting-it-on-oracle-cloud), below.

Set `IMAGE=ghcr.io/tahuffman1s/pack-ripper:latest` in `.env` and `run.sh` uses the published
image everywhere, pulling it instead of building when it is missing.

### The tunnel is in the image

`cloudflared` ships inside it, so a host with no inbound port to open can publish the app with
one container and no sidecar. It is **off unless `TUNNEL_TOKEN` (or `TUNNEL_TOKEN_FILE`) is
set** — Azure and Oracle terminate their own TLS and never start it.

- **Nothing changes when it is off.** `scripts/docker-entrypoint.sh` execs `node` straight away,
  so it is PID 1 and takes `docker stop` itself, exactly as before the tunnel existed. A one-off
  `docker run … admin list` is passed through untouched too, token or no token.
- **When it is on**, cloudflared starts beside the app and reaches it over the container's own
  loopback — so the tunnel's origin URL in the Cloudflare dashboard is `http://localhost:3000`.
- **Either half dying takes the container down**, so `restart: unless-stopped` gets its chance.
  A tunnel that quietly died would otherwise leave a container that looks perfectly healthy and
  is reachable by nobody.
- **The healthcheck checks both**: `/api/health` on loopback, and, only when a token is set,
  cloudflared's own `/ready` on its loopback-bound metrics port.
- **The binary is pinned** in the Dockerfile rather than tracking `latest`, and is copied out of
  Cloudflare's own image so each build gets its own architecture without naming one. It costs
  ~39 MB, which is most of why the image grew from ~174 MB to ~216 MB.

The `--no-autoupdate` flag matters more here than in a sidecar: cloudflared's updater rewrites
its own binary and restarts itself, which inside a container is both futile and a restart nobody
asked for. Bump the pinned version deliberately instead.

## Hosting it in Azure — retired

The public copy used to run on **Azure Container Apps**. It does not any more, and this section is
a signpost rather than instructions.

Two things pushed it off. Container Apps costs $10–15 a month because always-on and consumption
billing do not mix — the free grant is 180,000 vCPU-seconds, which at 0.5 vCPU is 100 hours, not a
month. And the database had to live on an **Azure Files (SMB) share**, which is where every
data-loss incident this project ever had came from: a share that had not attached yet is
indistinguishable from a first-ever boot, SMB can refuse a rename onto an existing file, and a
container killed mid-write left a torn 4 MB file that the next boot had to recover from. Roughly
two thirds of the old `db.js` was machinery defending against exactly those three failures.

Moving to Postgres removed the class of problem, and moving to a Raspberry Pi removed the bill.
See [Hosting it on a Raspberry Pi](#hosting-it-on-a-raspberry-pi), which is where the public copy
runs now, or [Hosting it on Oracle Cloud](#hosting-it-on-oracle-cloud) for a free VM.

If you do want Container Apps: the app needs a real Postgres, which on Azure means **Azure
Database for PostgreSQL Flexible Server** (a burstable B1ms is roughly $13–25/month on top of the
compute). Set `DATABASE_URL` to its connection string and `PGSSLMODE=no-verify` if its certificate
chain is not one this image trusts. Do not put Postgres's data directory on an SMB share.

## Hosting it on Oracle Cloud

Container Apps costs $10–15 a month because always-on and consumption billing do not mix: the
free grant is 180,000 vCPU-seconds, which at 0.5 vCPU is 100 hours, not a month. Oracle's
**Always Free** tier is an actual VM, free indefinitely, and comfortably bigger than this app
needs — 2 OCPU and 12 GB of Ampere ARM plus 200 GB of block storage.

A VM also fixes the thing Azure made awkward. There is no SMB share here, so `.data` **and**
`.cache` both live on local disk and the "do not mount `.cache`" rule stops applying.

What you give up: Oracle terminates no TLS and hands out no hostname, so `deploy/oracle/` runs
Caddy alongside the app to do both. And backups become yours.

### What Oracle asks for, in order

**1. An account, and a home region you cannot change.** Pick one near you with Ampere capacity;
the home region is permanent. A card is required for identity verification and is not charged for
always-free resources.

**2. An instance.** Compute → Instances → Create:

| Field | Value |
|---|---|
| Image | Canonical Ubuntu 24.04 |
| Shape | **VM.Standard.A1.Flex** (Ampere, "Always Free-eligible") |
| OCPUs / memory | 1 / 6 GB |
| Boot volume | Default (~50 GB, inside the free 200) |
| Public IPv4 | Assign |
| SSH key | Save the private key — there is no second chance |

Ask for 1 OCPU rather than the full 2: it is still six times this app's 1 GiB, and smaller
requests are likelier to place. **"Out of host capacity" is the normal experience** on A1 — it
means the region is full, not that anything is wrong. Retry, try another availability domain, or
try again in a few hours.

**3. Ingress for 80 and 443.** Instance → its subnet → its security list → Add ingress rules.
Source `0.0.0.0/0`, TCP, destination port 80, then again for 443. Stateless: no.

**4. The host firewall, which is the part that wastes an afternoon.** Oracle's Ubuntu images ship
`iptables-persistent` with a rule rejecting everything except SSH, so a port opened in the console
can still refuse connections. Docker's published ports are DNAT'd in `PREROUTING` and traverse
`FORWARD` rather than `INPUT`, so they often work regardless — but check rather than assume, and
adding the rules costs nothing:

```bash
sudo iptables -L INPUT --line-numbers          # find the REJECT rule's number
sudo iptables -I INPUT <that number> -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT <that number> -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save                 # or they vanish on reboot
```

**5. Docker.**

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu                 # log out and back in
sudo systemctl enable --now docker             # so it survives a reboot
```

**6. DNS.** Point an A record at the instance's public IP. Caddy proves control over that name
over port 80 to get a certificate, so an IP alone will not do — Let's Encrypt does not issue for
one. A free DuckDNS subdomain works.

### Bringing it up

```bash
git clone https://github.com/tahuffman1s/Pack-Ripper.git
cd Pack-Ripper/deploy/oracle
cp .env.example .env
vi .env                                        # DOMAIN is the only required value
docker compose up -d
```

Only Caddy publishes ports; the app is reachable on the compose network and nowhere else, so
there is no unencrypted route in from outside. The first boot takes a couple of minutes to fetch
the Scryfall set list and probe sealed prices — the Caddyfile's `lb_try_duration` waits it out
instead of returning a 502.

The [admin CLI](#admin) runs inside the container, where the app is on loopback:

```bash
docker exec -it packripper admin status
docker exec -it packripper admin gold travis 5000
```

`docker compose logs -f app` shows the same `db: loaded N account(s)` line described
[above](#checking-that-the-database-is-actually-mounted) — with a bind mount on a real disk it is
much harder to get wrong than a revision template, but it is still the line to read after a
deploy.

### Shipping a new build

```bash
vi .env                                        # TAG=sha-<short> from the Actions summary
docker compose up -d                           # recreates only what changed
docker image prune -f
```

`TAG=latest` with `docker compose pull && docker compose up -d` also works. Pinning the `sha-`
tag is better for the same reason as on Azure: you can tell what is running, and rolling back is
one line.

### Two things Oracle will not do for you

- **Idle reclamation.** Always Free compute can be reclaimed after seven days of low utilisation,
  and a quiet hobby app qualifies. Upgrading the account to Pay As You Go exempts you and still
  bills $0 for always-free resources — this is the single change worth making.
- **Backups.** The Postgres volume is every account, collection and wallet, and it is on one disk
  you own. A daily dump off the box — `pg_dump`, not a tar of the data directory, so it restores
  onto any Postgres including a newer major:

  ```
  0 4 * * * docker exec packripper-db pg_dump -U packripper -d packripper --clean --if-exists | gzip -9 > ~/backups/db-$(date +\%F).sql.gz
  ```

  To restore: `gzip -dc db-DATE.sql.gz | docker exec -i packripper-db psql -U packripper -d packripper`

  Oracle's own boot-volume backup policy (Storage → Block Volumes → the volume → Backups) covers
  the instance dying, and is a click.

## Hosting it on a Raspberry Pi

The cheapest option that exists, if the Pi is already on: a few pence of electricity a month, no
account with anyone, and nothing to reclaim your instance for being idle. `deploy/pi/` publishes
it through a **Cloudflare Tunnel**, which is free and needs no router configuration.

The tunnel is worth understanding, because it is the opposite of a port forward. `cloudflared`
dials *out* to Cloudflare and traffic returns down that connection, so:

- **No inbound port is open** on the router or the Pi. Nothing here publishes a port at all — the
  app is reachable by `cloudflared` on the container's own loopback and by nothing else.
- **No certificate to manage.** Cloudflare terminates TLS at its edge on your own hostname. This
  is why there is no Caddy here and no port 80.
- **Your home IP is not published** in DNS.

`cloudflared` is [in the image](#the-tunnel-is-in-the-image), so `deploy/pi/compose.yml` is a
single service and there is no sidecar to keep in step.

### The installer

`deploy/pi/install.sh` takes a fresh 64-bit Pi to a live public URL. On the Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/tahuffman1s/Pack-Ripper/main/deploy/pi/install.sh | bash
```

It checks the machine (64-bit, RAM, model), installs Docker and the compose plugin if they are
missing and enables the service at boot, clones the repo, writes `deploy/pi/.env` at mode **0600**
because it holds two credentials, brings the stack up, and waits — both for the app to answer and
for the tunnel to report a live connection to Cloudflare, so a bad token is caught then and there
rather than by you loading the site. Re-running it is safe: it keeps every answer already in
`.env`, so an update is the same one line.

It prompts for the tunnel token and the hostname, and prints the dashboard clicks that produce
them. To skip the questions entirely:

```bash
./deploy/pi/install.sh -y --domain packripper.example.com --token <TOKEN> --admin-user you
```

Useful flags: `--dry-run` prints every command it would run and changes nothing; `--data-dir` and
`--cache-dir` put the two volumes on a USB SSD; `--tag sha-<short>` pins a build; `--help` lists
the rest. On a Pi booting from an SD card it says so, points out any other disk it can see, and
lets you choose — it will not mount or format anything, because picking the wrong disk is not a
mistake a convenience script gets to make.

### Updates, including the ones you are not there for

Re-running the installer **is** the update, and it keeps everything: it reuses every answer in
`.env`, pulls the published image, and recreates the containers on it. The database, the cache and
`.env` are a bind mount, a bind mount and a file — `docker compose up -d` replaces containers, not
volumes, and nothing here ever passes `-v` or `down`. To skip the questions and just move forward:

```bash
cd ~/Pack-Ripper/deploy/pi
./install.sh --update
```

**And it keeps itself up to date.** The installer puts `deploy/pi/update.sh` on a systemd timer
(`packripper-update.timer`, every 15 minutes by default), so a push to `main` is live on the Pi
within about twenty minutes with nobody logged in. There is no webhook, because there is nothing
for one to call: GHCR does not send them, and the whole point of the tunnel is that this Pi
publishes no port. So it polls, which is one manifest request and costs nothing.

The part that makes it safe to leave running is what happens after the swap. `update.sh` waits up
to four minutes for the new container to answer `/api/health`; if it does not, it re-tags the
previous image, brings that back, and writes the bad image ID to `.update-skip` so the next run
does not walk into the same wall every quarter of an hour. **The site does not stay down waiting
for you to notice.** A successful update then removes the image it replaced, which matters on a
Pi — GHCR keeps every build, so going back is `TAG=sha-<short>` and one more run.

Only the app is touched. `db` is never pulled: it is pinned to a Postgres major because a newer
one will not read a data directory an older one wrote, and that is a change to make with a dump in
hand, not on a timer.

```bash
./update.sh --check       # is there a new build? (it downloads it to be sure)
./update.sh               # move to it now
sudo systemctl list-timers packripper-update
sudo journalctl -u packripper-update -n 30
./install.sh --update-interval 2h        # look less often
./install.sh --no-auto-update            # stop, and remove the timer
```

If backups are configured, `update.sh` takes one before the swap — a container swap does not touch
data, but a new build can carry a schema change, and that is exactly when an hour-old dump off the
Pi is worth having. A backup that fails is a loud warning, not a reason to stop updating forever.

Changes to `compose.yml`, `install.sh` or `update.sh` do **not** arrive this way: the timer moves
the image, not the checkout. `git pull` and re-run the installer for those. (The image build
ignores `deploy/**` for the same reason, so editing a compose file does not rebuild anything.)

### Hourly backups to a Nextcloud

`deploy/pi/backup.sh` tars `.data` and uploads it over WebDAV. The installer offers to set it up
and runs it on an hourly **systemd timer** — `Persistent=true`, so a run missed while the Pi was
off happens at the next boot rather than being skipped, and the output goes to the journal instead
of to mail nobody reads. Answer the installer's question, or pass the values:

```bash
./deploy/pi/install.sh --nextcloud-url https://cloud.example.com \
  --nextcloud-user you --nextcloud-pass <APP-PASSWORD> --nextcloud-path PackRipper
```

Use an **app password** (Settings → Security → Devices & sessions), not your login password: it
lives in plain text in `.env`, and an app password can be revoked by itself. The installer proves
the credentials work before it finishes and takes the first backup immediately — a backup that
only fails at 3am is worse than none, because you believe you have one.

**Retention needs no pruning.** Each run writes `db-hHH.sql.gz` for the current UTC hour, and the
04:00 run also writes `db-dN.sql.gz` for the weekday. That is 24 hourly slots and 7 daily ones,
each overwritten as it comes round again: the last day hour by hour, the last week day by day, 31
files forever. The obvious alternative — timestamped names plus a prune step — needs PROPFIND and
XML parsing to decide what to delete, and fails by silently filling the remote.

A 4 MB database compresses to about 450 KB, so the whole remote folder is ~14 MB.

```bash
./deploy/pi/backup.sh --test        # check the credentials, upload nothing real
./deploy/pi/backup.sh               # back up now
sudo systemctl list-timers packripper-backup
sudo journalctl -u packripper-backup -n 20
```

Each slot is a **`pg_dump`**, not a tar of the data directory, for two reasons — and the second is
the one that matters. A dump is SQL that any Postgres can restore, including a newer major on a
machine you have just rebuilt, where a copy of `PGDATA` is readable only by the exact major that
wrote it. And `pg_dump` runs in a single transaction against one consistent snapshot, where tarring
a live data directory reads files over several seconds while the server writes to them and produces
a torn copy that may not restore at all. (The old JSON database got away with `tar` only because it
was replaced by `rename`, so `tar` saw one whole version or the other.)

The unit runs as **root**. The reason changed with the database but did not go away: `backup.sh` no
longer reads root-owned files out of a bind mount, it runs `pg_dump` via `docker exec` — and access
to the Docker socket is the same privilege by a different name.

To restore, download a slot and replay it. The dump is `--clean --if-exists`, so it drops and
recreates as it goes and needs no empty database to land in — and no downtime:

```bash
cd ~/Pack-Ripper/deploy/pi
gzip -dc db-h14.sql.gz | sudo docker exec -i packripper-db psql -U packripper -d packripper
```

The manual route still works and is four commands:

```bash
git clone https://github.com/tahuffman1s/Pack-Ripper.git
cd Pack-Ripper/deploy/pi
cp .env.example .env
vi .env                                        # DOMAIN + TUNNEL_TOKEN
docker compose up -d
```

### The token and the hostname

The token comes from the Zero Trust dashboard → Networks → Tunnels → *Create a tunnel* →
Cloudflared; it is the string after `--token` in the install command it offers. Then add a public
hostname to that tunnel pointing at **`http://localhost:3000`**, which writes the CNAME for you —
there is no DNS record to create by hand. Localhost, not a service name: the tunnel and the app
share one container, and `http://app:3000` (what a sidecar would have used) resolves to nothing.

**The domain has to be on Cloudflare first**, which is the one prerequisite that is not in this
repo. Free plan, but it means adding the zone to a Cloudflare account and pointing the registrar's
nameservers at the two they give you — wherever the domain is registered, Cloudflare has to be
running its DNS. That is what lets a tunnel write its own CNAME, and it propagates in minutes to
hours. If the domain is already on Cloudflare, there is nothing to do.

Requirements are a **64-bit OS** (there is no armv7 build) and a Pi with 2 GB or more. A Pi 4 or 5
is comfortable; a Zero 2 W is not.

### The SD card problem, which used to be the real one

This was the strongest argument for moving off the JSON file, and the arithmetic is worth keeping
because it explains what changed:

- `.data/db.json` was **~4 MB**, and every slot spin, blackjack hit and card sold rewrote all of
  it (debounced 60 ms, so one action really was one write).
- An hour of slots at a spin every two seconds is ~1,800 writes ≈ **7 GB**, all landing on the same
  few flash blocks.

Postgres writes the row that changed plus a WAL record, so the same hour is megabytes rather than
gigabytes. The problem is not gone — steady small writes still wear a card, and WAL is its own
write stream — but it is roughly three orders of magnitude smaller.

**Point `DB_DIR` at a USB SSD anyway**, or boot the Pi from one. It is still the setting here that
decides whether the storage lasts years instead of months, and `install.sh` offers it when it
notices the Pi booted from `mmcblk`. `.cache` may as well go on the same disk.

### Two smaller things

- **A cold first boot can 524.** Cloudflare gives up on an origin after 100 seconds, and the very
  first request with an empty `.cache` fetches the Scryfall set list and probes ~55 sets before it
  answers. Warm it yourself before anyone else arrives, once per fresh `.cache`:

  ```bash
  docker compose exec app curl -fsS -o /dev/null http://127.0.0.1:3000/api/health
  ```

  Every later start reads the warm cache off disk and is quick.

- **Uptime is your ISP's uptime**, and a power cut is a restart. `restart: unless-stopped` plus
  Docker enabled at boot covers the reboot, and being killed mid-write is now Postgres's problem
  rather than this app's: a committed transaction is committed, and crash recovery replays the WAL
  on the next start. Back it up off the Pi anyway — that is what the section above is for.

### What Railway would have cost

Railway meters real usage — $10/GB-month of memory and $20/vCPU-month — so the $30 figure you get
by multiplying out a 1 vCPU / 1 GB allocation is a *fully saturated* container, not this one. A
quiet Node app actually consuming ~300 MB and almost no CPU lands near $4, under the Hobby plan's
$5 included credit. So Railway is realistically **the $5 plan minimum**, not $30.

That is not outrageous for what it does — a git push deploys it and volumes are a checkbox. It is
just $5 more than a Pi you already own, and $5 more than Oracle.

## Project layout

```
src/
  lib/
    economy.js            currency rules (gold <-> USD, sell rate)
    packs.js              product metadata + MTGJSON variant mapping
    collate.js            pure weighted-sheet sampler (no fs/fetch, seedable)
    serialized.js         serial numbering + scarcity pricing
    slots.js              reel strips, paytable, exact RTP solver
    blackjack.js          rules, hand evaluation, basic strategy
    catalog.js            the curated store line-up of sets
    cards.js              client card helpers (rarity, images, values)
    components/
      Pack3D.svelte       the animated three.js booster pack
      SlotMachine2D.svelte  the scrolling reels, win frames and payline traces
      PlayingCard.svelte  a blackjack card face
      PackOpener.svelte   full-screen rip + swipe-reveal experience
      CardTile.svelte     a card face for grids
      BuyTile.svelte      one buyable product + its quantity control
    server/
      db.js               Postgres pool, tx(), and the wallet/stats row locks
      schema.js           the schema, as SQL — applied on every boot
      rows.js             row <-> object mapping (cards, packs, openings)
      economySql.js       the gold conversions in SQL, for aggregate queries
      importJson.js       one-shot migration of a legacy .data/db.json
      auth.js             accounts, password hashing, sessions + expiry sweep
      scryfall.js         Scryfall fetch + disk cache + print index
      mtgjson.js          MTGJSON transport (gzip, versioning)
      collation.js        per-set collation slice + sheet classification
      neighbour.js        borrows a real structure for sets lacking data
      serializedStats.js  derives serialized rates from modelled sets
      opener.js           pack generation from real collation
      packvalue.js        exact pack EV from the real sheets (vintage price floor)
      slots.js            server-authoritative spin (crypto RNG)
      blackjack.js        shoe, dealing, and the game loop (crypto shuffle)
      rescue.js           net-worth check + Bulk Bin failsafe grant
      registry.js         in-memory set index, annotated with real products
      game.js             buy / open / sell / stats orchestration
      admin.js            every privileged action, in one dispatch table
  routes/
    +layout.svelte        app shell (top bar + bottom nav)
    (login|register|logout)
    +page.svelte          home dashboard
    store/                store + per-set product pages
    packs/                the vault of unopened packs
    slots/                the Mana Machine
    blackjack/            the blackjack table
    collection/           owned cards + selling
    stats/                statistics
    admin/                the admin panel (404 unless you are one)
    api/(open|sell|spin| JSON endpoints for the interactive flows
        rescue|blackjack)
    api/admin/            the one admin entry point (session cookie or ADMIN_TOKEN)
    api/health/           liveness, for HEALTHCHECK and the Azure probes
admin.sh                  admin commands, for the container host
scripts/
  admin.mjs               the admin CLI itself (also shipped in the image)
  docker-entrypoint.sh    the image's ENTRYPOINT: the app, + cloudflared if asked
  docker-healthcheck.sh   the image's HEALTHCHECK: the app, + the tunnel if there is one
  verify-odds.mjs         odds regression harness vs published figures
  verify-slots.mjs        exact slot RTP / paytable verification
  verify-blackjack.mjs    hand evaluation, shuffle bias, measured house edge
  measure-sealed-premium.mjs  re-derives the vintage sealed premium from live prices
deploy/
  pi/
    install.sh            fresh 64-bit Pi -> live public URL, re-runnable
    backup.sh             hourly .data -> Nextcloud over WebDAV, self-rotating
    compose.yml           one service: the app, with cloudflared inside it
    .env.example
  oracle/
    compose.yml           the app + Caddy for TLS
    Caddyfile
    .env.example
.github/workflows/
  publish-image.yml       build + push ghcr.io/tahuffman1s/pack-ripper
```

## Notes & knobs

- Starting gold, the gold/USD rate, and the sell rate live in `src/lib/economy.js`.
- Product metadata and MSRPs live in `src/lib/packs.js`. Slot structures are **not** defined
  there any more — they come from MTGJSON.
- The set line-up (and which products each set offers) lives in `src/lib/catalog.js`.
- Card data is cached for 14 days under `.cache/`; collation slices for 90 days (collation
  never changes once a set is released). Delete `.cache/` to refresh.
- Admin access is `ADMIN_USERNAMES` and `ADMIN_TOKEN`, both off when unset — see [Admin](#admin).
- **Shutdown is bounded, deliberately.** On SIGTERM the process leaves as soon as adapter-node
  reports the HTTP server drained (`sveltekit:shutdown`) — measured at ~100 ms, exit code 0. It does
  not wait for the background price warming, which on a cold cache runs for minutes of fetches and
  throttle timers and used to hold the process open long past any container's stop grace (measured:
  still running 122 seconds after SIGTERM, so every stop ended in a SIGKILL); that work produces
  nothing but regenerable `.cache`. If the drain never completes, `SHUTDOWN_GRACE_MS` (default 8000)
  leaves anyway, and the image sets adapter-node's own `SHUTDOWN_TIMEOUT=5` so a request that will
  not finish is closed first. This mattered enormously when a SIGKILL could interrupt a 4 MB write
  to the one file holding every account; it now just means a deploy is quick.
- **Vintage sealed prices depend on a computed floor.** A pre-2006 pack with no live TCGplayer
  listing is priced from the exact EV of its print sheets (`packvalue.js`), because the MSRP×age
  heuristic puts an Alpha booster at $43 against singles worth thousands. Those floors are warmed
  in the background at startup and cached in `.cache/collation/_ev.json`; `buy` and `sellPacks`
  compute one on demand rather than trust the cache, so a price never depends on cache warmth.

### Accuracy, honestly stated

Collation is **i.i.d. weighted sampling from reverse-engineered print-sheet weights**, not a
simulation of physical sheets. Real packs are cut from a contiguous slice of a printed sheet,
so packs within one box are correlated in ways per-pack weights cannot express. Buying a box
here is 36 independent packs.

173 of the ~186 booster-eligible sets have real MTGJSON collation. The rest are bonus sheets
and foreign reprints that were never sold sealed (now excluded from the store — there is no
"Draft Booster of The List"), plus sets too new for MTGJSON's last build. Those borrow the
slot structure of the nearest comparable set that does have data, and every card in such a
pack is flagged `estimated` and labelled in the UI.

Two numbers are genuinely unavailable from any API: the per-pack rate and print run for
serialized cards in the sets MTGJSON does not model. Wizards only ever publishes "less than
1%", and no Scryfall field carries a print run. Rather than invent them, both are derived at
runtime as the median of the sets MTGJSON *does* model — see `serializedStats.js`.

## Credits

Collation data from [MTGJSON](https://mtgjson.com) (MIT). Card data, images and prices from
[Scryfall](https://scryfall.com). Sealed prices from [tcgcsv.com](https://tcgcsv.com).

Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
This is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed
by Wizards.
