# syntax=docker/dockerfile:1

# PackRipper — SvelteKit on adapter-node.
#
# Three stages. The build stage needs the dev dependencies (vite, svelte,
# tailwind); the deps stage resolves the runtime dependencies on their own so
# neither one has to carry the other's; the runtime stage takes build/ and those.
#
# adapter-node bundles the entire server into build/, so the ONLY runtime
# dependency is the Postgres driver — Vite deliberately leaves packages listed in
# `dependencies` as external imports rather than bundling them, and `pg` reaches
# for pgpass lazily besides. Enumerating its transitive tree in vite.config.js
# would work today and break silently the next time pg adds a package, in
# production only, since dev resolves from node_modules either way. 760 KB of
# node_modules is the cheaper answer.
#
# Still no native modules: pg is pure JavaScript, and --omit=optional keeps
# pg-native (the libpq binding) out. That is what preserves "runs anywhere Node
# runs", which was the whole reason the database used to be a JSON file.

# ── build ──────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Puppeteer is a devDependency used only by the local UI checks. Left alone it
# downloads ~200 MB of Chromium into this layer for a browser nothing here runs.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Lockfile first, so editing source does not re-run the install.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── runtime dependencies ───────────────────────────────────────
# Its own stage, from the lockfile alone, so it is cached independently of the
# source and shares nothing with the dev dependencies above.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# ── runtime ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# curl is only here for HEALTHCHECK, which run.sh's startup wait also uses, and
# for warming a cold cache by hand on a Pi before Cloudflare's 100-second origin
# timeout can turn the first request into a 524.
RUN apk add --no-cache curl

# The Cloudflare Tunnel client, so a host with no inbound port to open — a Pi
# behind a router, above all — can publish this app without a second container
# and without a port forward. It stays dormant unless TUNNEL_TOKEN is set; see
# docker-entrypoint.sh.
#
# Copied out of Cloudflare's own image rather than downloaded, because that
# resolves architecture on its own: the arm64 build job gets the arm64 binary
# without this file naming either. It is a static Go binary and runs on musl
# unchanged, despite that image being Debian-based.
#
# Pinned, not `latest` — otherwise two builds of the same commit can ship
# different tunnel clients. Bump this line deliberately; releases are at
# github.com/cloudflare/cloudflared/releases.
#
# Fully qualified because podman/buildah does not apply short-name resolution to
# a COPY --from and fails the build outright. BuildKit accepts either form, and
# run.sh here drives podman.
COPY --from=docker.io/cloudflare/cloudflared:2026.7.3 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

COPY --from=build /app/build ./build
COPY --from=deps /app/node_modules ./node_modules

# The manifest, for the version the admin panel reports. It also states
# "type": "module" for everything under /app, which until now was inferred:
# adapter-node emits ESM into build/ and Node 22 guesses right by sniffing the
# syntax. Saying it outright costs nothing and does not rely on that guess.
COPY package.json ./package.json

# The admin CLI, for a host with no copy of the repo — a `docker exec` into a Pi,
# above all. A dependency-free script that talks to the app over loopback; it
# carries no privileges of its own and does nothing without ADMIN_TOKEN set.
#
# `admin` on the PATH because this is typed by hand in a web console, where
# `node /app/admin.mjs gold someone 5000` is a lot to get right. The repo's
# ./admin.sh is NOT here and cannot be: it is bash, and this image has none — and
# everything it does (find .env, choose between local node and `exec`) is a
# question that only exists outside the container.
COPY scripts/admin.mjs ./admin.mjs
RUN ln -s /app/admin.mjs /usr/local/bin/admin

COPY scripts/docker-entrypoint.sh scripts/docker-healthcheck.sh /usr/local/bin/

# .cache is ~100 MB of regenerated Scryfall, MTGJSON and TCGplayer data. Losing
# it costs a slow first minute, nothing more.
#
# .data no longer holds the database — that is Postgres now — and an empty one is
# the normal steady state. It is still mounted for exactly one reason: a legacy
# .data/db.json found there is imported into an empty database on first boot. See
# importJson.js. Once the import has happened it can stop being mounted.
RUN mkdir -p /app/.data /app/.cache
VOLUME ["/app/.data", "/app/.cache"]

# HOST=0.0.0.0 so the port is reachable from outside the container; adapter-node
# otherwise binds loopback, and neither a published port nor cloudflared can
# reach it.
# SHUTDOWN_TIMEOUT is adapter-node's, in seconds: how long a stopping server
# waits for a request that will not finish before it closes the connection
# anyway. Its default of 30 is longer than the ten seconds a container gets to
# stop, which turns every slow request into a SIGKILL. Five leaves room for
# db.js's own backstop to be the thing that never fires.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SHUTDOWN_TIMEOUT=5

# Which commit this image is, so the admin panel can answer "what is deployed?".
# It has to come in as a build arg: the image carries no git checkout, and a
# container cannot read the tag it was pulled under — `latest` in particular says
# nothing about which build it currently resolves to. Left empty by a plain
# `docker build`, which the panel reports honestly as an unknown version rather
# than guessing. The image workflow passes all three; see build-args there.
#
# Last in the file on purpose. These change on every commit, so anything below
# them would lose its layer cache on every build.
ARG GIT_SHA=""
ARG GIT_REF=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA \
    GIT_REF=$GIT_REF \
    BUILD_TIME=$BUILD_TIME

# Only the app. cloudflared publishes nothing — it dials out — and its metrics
# port is bound to loopback inside the container.
EXPOSE 3000

# A cold start fetches the Scryfall set list and probes ~55 sets for sealed
# prices, so the first boot is slower than later ones — hence the start period.
# The script also checks the tunnel, when there is one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD docker-healthcheck.sh || exit 1

# The entrypoint execs this untouched when no TUNNEL_TOKEN is set, so `node` is
# still PID 1 in every deployment that does not want a tunnel.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "build/index.js"]
