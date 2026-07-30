# syntax=docker/dockerfile:1

# PackRipper — SvelteKit on adapter-node.
#
# Two stages. The build stage needs the dev dependencies (vite, svelte,
# tailwind); the runtime stage needs almost nothing, because adapter-node
# bundles the entire server into build/ — its only imports are node: builtins.
# No node_modules, no package.json, no native modules anywhere.

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

# ── runtime ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# curl is only here for HEALTHCHECK, which run.sh's startup wait also uses. The
# Azure Container Apps probes hit /api/health over the network instead, so they
# do not need it.
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

# The admin CLI, for a host with no copy of the repo — the Azure console, above
# all. A dependency-free script that talks to the app over loopback; it carries no
# privileges of its own and does nothing without ADMIN_TOKEN set.
#
# `admin` on the PATH because this is typed by hand in a web console, where
# `node /app/admin.mjs gold someone 5000` is a lot to get right. The repo's
# ./admin.sh is NOT here and cannot be: it is bash, and this image has none — and
# everything it does (find .env, choose between local node and `exec`) is a
# question that only exists outside the container.
COPY scripts/admin.mjs ./admin.mjs
RUN ln -s /app/admin.mjs /usr/local/bin/admin

COPY scripts/docker-entrypoint.sh scripts/docker-healthcheck.sh /usr/local/bin/

# Bind-mounted by run.sh / compose; in Azure only .data is mounted, from a file
# share. Declared anyway so an unmounted container still boots (it just starts
# with an empty vault and a cold cache).
RUN mkdir -p /app/.data /app/.cache
VOLUME ["/app/.data", "/app/.cache"]

# HOST=0.0.0.0 so the port is reachable from outside the container; adapter-node
# otherwise binds loopback, and neither a published port nor Azure's ingress can
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
