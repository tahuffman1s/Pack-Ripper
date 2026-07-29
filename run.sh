#!/usr/bin/env bash
#
# PackRipper container runner — local only.
#
# Public hosting lives in Azure Container Apps now, managed in the Portal (the
# README lists the settings it needs). This script runs the same image on this
# machine. It drives podman or docker directly rather than compose, because
# podman ships without a compose provider and this machine has none: `podman
# compose` here fails with "looking up compose provider failed".
# docker-compose.yml is still in the repo for anyone who does have one. This
# script needs neither.
#
#   ./run.sh              start the app on http://localhost:PORT
#   ./run.sh down         stop and remove the container
#   ./run.sh logs         follow the container's log
#   ./run.sh restart      down, then up again (keeps .data and .cache)
#   ./run.sh build        rebuild the image
#   ./run.sh pull         fetch the image from GHCR instead of building it
#   ./run.sh url          print the local URL
#   ./run.sh status
#   ./run.sh shell        a shell inside the running container
#
# Flags: --build forces an image rebuild before starting.

set -euo pipefail

SELF=$(readlink -f "$0")
cd "$(dirname "$SELF")"

DEFAULT_IMAGE=packripper:latest
APP=packripper

# ── output ─────────────────────────────────────────────────────
if [ -t 1 ]; then
	B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
	B=; DIM=; R=; G=; Y=; N=
fi
say()  { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s warn%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%sfail%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# ── container engine ───────────────────────────────────────────
if command -v podman >/dev/null 2>&1; then
	ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
	ENGINE=docker
else
	die "neither podman nor docker is installed"
fi

# Rootless podman maps the container's root to your own user, so a bind mount
# stays writable and files it creates come out owned by you. Rootful docker does
# not, and would leave .data owned by real root — so there we run as the caller.
USER_ARGS=()
if [ "$ENGINE" = docker ]; then
	USER_ARGS=(--user "$(id -u):$(id -g)")
fi

# SELinux is enforcing on Fedora and blocks a container from reading an
# unlabelled bind mount. `:z` adds a shared label, so the app still works when
# you run it natively (`npm run dev`) against the same directories. `:Z` would
# take exclusive ownership of the label and break that.
MOUNT_SUFFIX=
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != Disabled ]; then
	MOUNT_SUFFIX=":z"
fi

# ── configuration ──────────────────────────────────────────────
if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
fi
PORT="${PORT:-3000}"
BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-2M}"

# Set IMAGE (in .env or the environment) to ghcr.io/tahuffman1s/pack-ripper:latest
# to run the published image instead of a locally built one.
IMAGE="${IMAGE:-$DEFAULT_IMAGE}"

exists()  { $ENGINE container inspect "$1" >/dev/null 2>&1; }
running() { [ "$($ENGINE container inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ]; }

# ── image ──────────────────────────────────────────────────────
build_image() {
	say "building $IMAGE"
	# podman defaults to the OCI image format, which has no HEALTHCHECK field and
	# drops the one in the Dockerfile with a warning. This script does its own
	# readiness wait either way, but docker-compose.yml's `service_healthy`
	# dependency needs it, so keep the docker format.
	local fmt=()
	[ "$ENGINE" = podman ] && fmt=(--format docker)
	$ENGINE build "${fmt[@]}" -t "$IMAGE" .
	ok "image built"
}

have_image() { $ENGINE image inspect "$IMAGE" >/dev/null 2>&1; }

# ghcr.io/owner/name vs packripper:latest. The first path component of a remote
# reference contains a dot or a port; a bare local tag never does.
is_remote_image() {
	local host=${IMAGE%%/*}
	[ "$host" != "$IMAGE" ] || return 1
	case "$host" in *.* | *:*) return 0 ;; esac
	return 1
}

pull_image() {
	is_remote_image || die "IMAGE ($IMAGE) is a local tag — nothing to pull. Use ./run.sh build."
	say "pulling $IMAGE"
	$ENGINE pull "$IMAGE"
	ok "image pulled"
}

# Missing image: pull it when it comes from a registry, build it when it does not.
ensure_image() {
	have_image && return 0
	if is_remote_image; then pull_image; else build_image; fi
}

# ── app ────────────────────────────────────────────────────────
start_app() {
	mkdir -p .data .cache

	if exists "$APP"; then $ENGINE rm -f "$APP" >/dev/null; fi

	say "starting $APP"
	# ORIGIN is pinned to the address you will actually type. SvelteKit rejects
	# any POST whose Origin header disagrees with the origin it thinks it is
	# serving, and a mismatch does not break pages — it breaks every login and
	# every purchase, which looks like "buying silently fails".
	$ENGINE run -d \
		--name "$APP" \
		--restart unless-stopped \
		--publish "127.0.0.1:${PORT}:3000" \
		"${USER_ARGS[@]}" \
		--env "NODE_ENV=production" \
		--env "HOST=0.0.0.0" \
		--env "PORT=3000" \
		--env "BODY_SIZE_LIMIT=${BODY_SIZE_LIMIT}" \
		--env "ORIGIN=http://localhost:${PORT}" \
		--volume "$PWD/.data:/app/.data${MOUNT_SUFFIX}" \
		--volume "$PWD/.cache:/app/.cache${MOUNT_SUFFIX}" \
		"$IMAGE" >/dev/null
	ok "container up"
}

app_healthy() {
	$ENGINE exec "$APP" curl -fsS -o /dev/null http://127.0.0.1:3000/api/health 2>/dev/null
}

# Wait for the server to answer, not just for the container to exist. A cold
# .cache means the first boot fetches the Scryfall set list and probes ~55 sets
# for sealed prices before it serves anything. /api/health is behind the same
# hooks.server.js warmup as any page, so a 200 there means the sets are loaded.
wait_for_app() {
	say "waiting for the app to answer"
	local i
	for i in $(seq 1 180); do
		if app_healthy; then
			ok "responding after ${i}s"
			return 0
		fi
		if ! running "$APP"; then
			$ENGINE logs --tail 30 "$APP" >&2 || true
			die "the container stopped while starting"
		fi
		sleep 1
	done
	$ENGINE logs --tail 30 "$APP" >&2 || true
	die "the app did not respond within 180s"
}

print_url() {
	printf '\n  %sLocal:%s  http://localhost:%s\n' "$B" "$N" "$PORT"
	printf '  %s(public hosting is Azure Container Apps — see the README)%s\n\n' "$DIM" "$N"
}

# ── commands ───────────────────────────────────────────────────
cmd_up() {
	ensure_image
	start_app
	wait_for_app
	print_url
}

cmd_down() {
	if exists "$APP"; then $ENGINE rm -f "$APP" >/dev/null && ok "removed $APP"; fi
}

cmd_status() {
	$ENGINE ps --filter "name=${APP}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

usage() { sed -n '/^# PackRipper container runner/,/^set -euo/p' "$0" | sed '/^set -euo/d; s/^# \?//'; }

# --build anywhere in the arguments forces a rebuild first.
ARGS=()
FORCE_BUILD=
for a in "$@"; do
	case "$a" in
		--build) FORCE_BUILD=1 ;;
		*) ARGS+=("$a") ;;
	esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
[ -n "$FORCE_BUILD" ] && build_image

case "${1:-up}" in
	up | local) cmd_up ;;
	down | stop) cmd_down ;;
	restart) cmd_down; cmd_up ;;
	build)   [ -n "$FORCE_BUILD" ] || build_image ;;
	pull)    pull_image ;;
	logs)    $ENGINE logs -f "$APP" ;;
	url)     print_url ;;
	status)  cmd_status ;;
	shell)   $ENGINE exec -it "$APP" sh ;;
	-h|--help|help) usage ;;
	*)       die "unknown command '$1' — try ./run.sh --help" ;;
esac
