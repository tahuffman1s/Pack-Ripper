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

COPY --from=build /app/build ./build

# Bind-mounted by run.sh / compose; in Azure only .data is mounted, from a file
# share. Declared anyway so an unmounted container still boots (it just starts
# with an empty vault and a cold cache).
RUN mkdir -p /app/.data /app/.cache
VOLUME ["/app/.data", "/app/.cache"]

# HOST=0.0.0.0 so the port is reachable from outside the container; adapter-node
# otherwise binds loopback, and neither a published port nor Azure's ingress can
# reach it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# A cold start fetches the Scryfall set list and probes ~55 sets for sealed
# prices, so the first boot is slower than later ones — hence the start period.
# /api/health is behind the same hooks.server.js warmup as any page, so it does
# not report healthy early; it is just cheaper than rendering one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "build/index.js"]
