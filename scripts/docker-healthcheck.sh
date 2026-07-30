#!/bin/sh
#
# The image's HEALTHCHECK. A script rather than an inline CMD because what
# "healthy" means depends on whether this container is also running a tunnel.

set -eu

# /api/health is behind the same hooks.server.js warmup as any page, so it does
# not answer early — it is just cheaper than rendering one. The Dockerfile's
# start period is what covers the cold first boot.
curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3000}/api/health"

# With a tunnel, "the app answers on loopback" is only half the question; the
# other half is whether Cloudflare can still reach it. cloudflared's /ready is
# 200 only while at least one edge connection is registered, so a tunnel that
# has lost all of them now shows as an unhealthy container instead of a healthy
# one that nobody on the internet can load.
if [ -n "${TUNNEL_TOKEN:-}" ] || [ -n "${TUNNEL_TOKEN_FILE:-}" ]; then
	curl -fsS -o /dev/null http://127.0.0.1:2000/ready
fi
