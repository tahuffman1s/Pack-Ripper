#!/usr/bin/env bash
#
# PackRipper admin commands.
#
# A thin wrapper around scripts/admin.mjs, which talks to the running app over
# HTTP and authenticates with ADMIN_TOKEN. It does NOT connect to Postgres
# directly — going through the app means no database credentials here, the same
# validation the panel gets, and one audit log for both.
#
#   ./admin.sh help                       every command
#   ./admin.sh status                     health, totals, uptime
#   ./admin.sh list                       every account
#   ./admin.sh admin travis               grant admin — /admin appears in their nav
#   ./admin.sh gold travis 50000          hand out gold (negative takes it back)
#   ./admin.sh packs travis fdn play 36   grant a box of Foundations Play Boosters
#   ./admin.sh token                      generate a value for ADMIN_TOKEN
#
# First-time setup, once:
#
#   1. ./admin.sh token, and put ADMIN_TOKEN=<it> in .env — the repo root one
#      locally, or deploy/<host>/.env on a server.
#   2. ADMIN_USERNAMES=<your username> in the same place, so you can reach the
#      panel at /admin without needing the CLI at all. A fresh database has no
#      admins and nothing in the UI can promote the first one.
#   3. Restart the container. ./run.sh restart, or `docker compose up -d` on a
#      server.
#
# Flags handled here (everything else is passed straight through):
#
#   --in-container   run inside the container via podman/docker exec, instead of
#                    on this machine. Automatic when node is not installed here.
#                    Set PACKRIPPER_CONTAINER if it is not named `packripper`.
#                    In the container the same CLI is on the PATH as `admin` — use
#                    that directly from a `docker exec` shell. This script is not
#                    there (it is bash; the image is Alpine) and is not needed.
#   --url URL        a remote app — the public hostname, say. Passed through.

set -euo pipefail

SELF=$(readlink -f "$0")
cd "$(dirname "$SELF")"

CLI=scripts/admin.mjs

if [ -t 2 ]; then R=$'\033[31m'; N=$'\033[0m'; else R=; N=; fi
die() { printf '%sfail%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# ── configuration ──────────────────────────────────────────────
# ADMIN_TOKEN and PORT live in .env alongside everything else run.sh reads.
if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
fi

# Only --in-container needs this: the container run.sh starts is named packripper,
# but a compose stack or a second copy may not be.
APP="${PACKRIPPER_CONTAINER:-packripper}"

# ── where to run ───────────────────────────────────────────────
IN_CONTAINER=
ARGS=()
for a in "$@"; do
	case "$a" in
		--in-container) IN_CONTAINER=1 ;;
		*) ARGS+=("$a") ;;
	esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [ -z "$IN_CONTAINER" ] && ! command -v node >/dev/null 2>&1; then
	IN_CONTAINER=1
fi

if [ -n "$IN_CONTAINER" ]; then
	if command -v podman >/dev/null 2>&1; then ENGINE=podman
	elif command -v docker >/dev/null 2>&1; then ENGINE=docker
	else die "no node on this machine and neither podman nor docker to fall back to"
	fi
	# The image carries the script at /app/admin.mjs, and the container already has
	# ADMIN_TOKEN in its environment — so nothing needs passing in. From in there
	# the app is on loopback, which is the CLI's default.
	$ENGINE container inspect "$APP" >/dev/null 2>&1 ||
		die "no container named $APP — start it with ./run.sh, or drop --in-container"
	# The explicit path, not the `admin` symlink: this wrapper gains nothing from the
	# short name, and the path works against an older image that predates the link.
	exec $ENGINE exec -e "TERM=${TERM:-dumb}" "$APP" node /app/admin.mjs "$@"
fi

[ -f "$CLI" ] || die "$CLI is missing"
exec node "$CLI" "$@"
