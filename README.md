# ⚡ PackRipper

A mobile-first **Magic: The Gathering pack-opening simulator** built with SvelteKit. Buy
sealed product with free in-game gold, rip open booster packs in 3D, swipe through your
pulls, build a collection, and sell cards back for gold. Real cards, real art, real prices —
all sourced live from [Scryfall](https://scryfall.com).

It's a simulator: the currency is free and no real money is ever involved.

## Features

- **Login system** — username/password accounts with hashed passwords (scrypt) and session
  cookies. Every new account starts with **1,000 free gold**.
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
- **Mana Machine** — a 3D slot machine: 3 reels × 3 rows, **5 paylines**, and a **free-spin bonus
  round**. Reels are drums of 24 physical stops built in three.js; odds come from how often a symbol
  appears on its reel strip, the same way a mechanical slot works — and the same way pack collation
  works here. Because the 3×3 window is fully determined by the three reel stops, the whole game is
  still solvable exactly: `node scripts/verify-slots.mjs` enumerates all 24³ = 13,824 outcomes across
  every payline and the bonus round.

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
- **Mobile-first UI** with DaisyUI on a custom arcane/foil dark theme.

## Tech stack

- **SvelteKit 2 + Svelte 5** (runes)
- **Tailwind CSS 4 + DaisyUI 5**
- **three.js** for the 3D pack
- **MTGJSON** (MIT) for booster collation — fetched lazily per set as a `.json.gz`, gunzipped
  with `node:zlib`, and cached as a ~110 KB slice under `.cache/collation/`
- **Scryfall API** for card data, art, treatments and prices (cached to disk under `.cache/`)
- **Zero native dependencies** — accounts, wallets, collections and stats are stored in a
  small file-backed JSON database under `.data/db.json`.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

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

- **`.data` and `.cache` are bind-mounted**, so accounts survive a rebuild and the image
  never contains a database. Neither directory is in the image — `.data` holds real password
  hashes and live session tokens, and baking those into a layer would ship them wherever the
  image goes. Under rootless podman the container writes them as your own user.
- **The request origin has to be right.** SvelteKit refuses any POST whose `Origin` header
  disagrees with the origin it believes it is serving, and a mismatch breaks every login and
  purchase while pages keep loading normally. `run.sh` pins `ORIGIN` to
  `http://localhost:PORT`; in Azure `azure/deploy.sh` pins it to the real `https://` hostname.

The runtime image is ~174 MB and contains no `node_modules` at all: adapter-node bundles the
whole server into `build/`, whose only imports are `node:` builtins.

`docker-compose.yml` does the same thing for anyone who has a compose provider.

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
- **`linux/amd64` only.** Adding `linux/arm64` to `platforms:` works, but `npm ci` and the
  vite build then run under QEMU and the job goes from ~3 minutes to ~20.

Set `IMAGE=ghcr.io/tahuffman1s/pack-ripper:latest` in `.env` and `run.sh` uses the published
image everywhere, pulling it instead of building when it is missing.

## Hosting it in Azure

The public copy runs on **Azure Container Apps**, pulling that same GHCR image. Azure
terminates TLS and hands out a stable hostname, so there is no tunnel and nothing to
re-publish when it restarts:

```
https://packripper.<generated>.<region>.azurecontainerapps.io
```

One script owns the whole thing, and it is idempotent — run it again to ship a new image or
change a setting:

```bash
az login                     # once
azure/deploy.sh              # create or update everything, then print the URL
azure/deploy.sh logs         # follow the container log
azure/deploy.sh status       # revision, replica, image, provisioning state
azure/deploy.sh restart
CONFIRM=1 azure/deploy.sh destroy    # delete the resource group and stop the meter
```

No Azure CLI installed? `sudo dnf install azure-cli`, or skip the install and run the script
in [Cloud Shell](https://shell.azure.com), which has it already.

What it creates, and why each piece is the way it is:

- **A resource group** (`packripper-rg`, `eastus`) holding everything, so `destroy` is one
  call and nothing is left billing quietly. Override with `RG=` / `LOCATION=`.
- **A Container Apps environment** with `--logs-destination none`. That skips the Log
  Analytics workspace Azure would otherwise create and bill for; `azure/deploy.sh logs`
  streams from the container itself and does not need it.
- **A storage account and one 5 GiB file share**, mounted at `/app/.data`. That is the whole
  database — accounts, collections, wallets, the serial-number ledger — and it survives every
  deploy, revision and restart.
- **`.cache` deliberately left on local disk.** It is ~100 MB of regenerated Scryfall,
  MTGJSON and TCGplayer data with its own TTLs, read as thousands of small files, which is
  exactly what SMB is worst at. Keeping it local costs a slow first minute after each deploy —
  the startup probe budgets five minutes for it — and makes every request after that fast.
- **Exactly one replica**, `minReplicas: 1` and `maxReplicas: 1`. `db.js` keeps the database
  in memory and flushes it to a single file, so a second replica would not see the first one's
  writes and would overwrite them. Scaling this app means a real database first, not a bigger
  `maxReplicas`.
- **Always on**, because scaling to zero would mean the first visitor after an idle period
  waits out a cold start. At 0.5 vCPU / 1 GiB that is roughly $10–15 a month of credits;
  Container Apps bills per second, so `destroy` genuinely stops it.
- **`ORIGIN` pinned** to `https://<the app's hostname>`, worked out before the app is created
  from the environment's default domain. Get this wrong and pages still render while every
  login and purchase fails the CSRF check.

### Deploying on push

`.github/workflows/deploy-azure.yml` rolls each successful image build out to Azure, deploying
the immutable `sha-<short>` tag rather than `latest` so what is running is always identifiable
and a rollback is one `workflow_dispatch` with an older tag. It waits for `/api/health` to
answer 200 and fails the run if it never does.

It stays dormant until three repository variables exist. To set them up:

```bash
azure/github-oidc.sh
```

That creates an Entra app registration, a federated credential trusted **only** for pushes to
this repo's `main`, and a Contributor role assignment scoped to the resource group and nothing
wider. GitHub exchanges its own short-lived OIDC token for an Azure one at deploy time, so
there is no client secret to leak or rotate — the three values it prints are identifiers, not
credentials. If your account cannot create app registrations, skip it and run
`azure/deploy.sh` by hand when you want to ship.

### A custom domain

Container Apps will serve one with a free managed certificate:

```bash
az containerapp hostname add      -n packripper -g packripper-rg --hostname packripper.example.com
az containerapp ssl upload        # or: az containerapp hostname bind --validation-method CNAME
```

Then set `ORIGIN` to that hostname — `ORIGIN=https://packripper.example.com azure/deploy.sh`
will not do it for you, because the script derives `ORIGIN` from the Azure hostname; edit
`write_spec` or pass `ORIGIN` through if you go this route.

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
      PlayingCard.svelte  a blackjack card face
      PackOpener.svelte   full-screen rip + swipe-reveal experience
      CardTile.svelte     a card face for grids
      BuyTile.svelte      one buyable product + its quantity control
    server/
      db.js               file-backed JSON store (atomic writes)
      auth.js             accounts, password hashing, sessions
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
    api/(open|sell|spin| JSON endpoints for the interactive flows
        rescue|blackjack)
    api/health/           liveness, for HEALTHCHECK and the Azure probes
scripts/
  verify-odds.mjs         odds regression harness vs published figures
  verify-slots.mjs        exact slot RTP / paytable verification
  verify-blackjack.mjs    hand evaluation, shuffle bias, measured house edge
  measure-sealed-premium.mjs  re-derives the vintage sealed premium from live prices
azure/
  deploy.sh               create or update the Container App (idempotent)
  github-oidc.sh          one-time trust so Actions can deploy without a secret
.github/workflows/
  publish-image.yml       build + push ghcr.io/tahuffman1s/pack-ripper
  deploy-azure.yml        roll each built image out to Container Apps
```

## Notes & knobs

- Starting gold, the gold/USD rate, and the sell rate live in `src/lib/economy.js`.
- Product metadata and MSRPs live in `src/lib/packs.js`. Slot structures are **not** defined
  there any more — they come from MTGJSON.
- The set line-up (and which products each set offers) lives in `src/lib/catalog.js`.
- Card data is cached for 14 days under `.cache/`; collation slices for 90 days (collation
  never changes once a set is released). Delete `.cache/` to refresh.

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
