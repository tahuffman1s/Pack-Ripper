#!/usr/bin/env bash
#
# PackRipper container runner — local only.
#
# Public hosting is a Raspberry Pi behind a Cloudflare Tunnel; see deploy/pi/.
# This script runs the same image on this machine. It drives podman or docker
# directly rather than compose, because podman ships without a compose provider
# and this machine has none: `podman compose` here fails with "looking up compose
# provider failed". docker-compose.yml is still in the repo for anyone who does
# have one. This script needs neither.
#
# TWO containers now, on a private network: the app, and the Postgres that holds
# every account. The database lives in a named VOLUME, not a bind mount, so
# `./run.sh down` and `restart` cannot lose it — only `./run.sh reset` can, and it
# asks first.
#
#   ./run.sh              start Postgres and the app on http://localhost:PORT
#   ./run.sh down         stop and remove both containers (KEEPS the database)
#   ./run.sh logs         follow the app's log     (./run.sh logs db for Postgres)
#   ./run.sh restart      down, then up again
#   ./run.sh build        rebuild the image
#   ./run.sh pull         fetch the image from GHCR instead of building it
#   ./run.sh psql         open psql against the running database
#   ./run.sh dump [FILE]  pg_dump to a file (default: packripper-<date>.sql)
#   ./run.sh reset        DESTROY the database volume and start over
#   ./run.sh url          print the local URL
#   ./run.sh status
#   ./run.sh shell        a shell inside the running app container
#
# Flags: --build forces an image rebuild before starting.

set -euo pipefail

SELF=$(readlink -f "$0")
cd "$(dirname "$SELF")"

DEFAULT_IMAGE=packripper:latest
APP=packripper
DB=packripper-db
NET=packripper
# The database, deliberately outside the container lifecycle. Removing a container
# must never be able to remove the accounts.
DB_VOLUME=packripper-pgdata
DB_IMAGE=postgres:17-alpine

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

# Admin access. Both are optional and both are empty by default, which turns the
# corresponding door off rather than leaving it unlocked: no ADMIN_TOKEN means
# ./admin.sh cannot authenticate at all, and no ADMIN_USERNAMES means the only
# admins are the ones already flagged in the database.
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
ADMIN_USERNAMES="${ADMIN_USERNAMES:-}"

# Postgres. Defaulted rather than required, unlike the Pi: this database is bound
# to loopback on a development machine. Override in .env if you care.
POSTGRES_USER="${POSTGRES_USER:-packripper}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-packripper}"
POSTGRES_DB="${POSTGRES_DB:-packripper}"
# Host port, so psql and scripts/import-json-db.js can reach it from outside the
# container. 5432 inside is fixed; this only moves the published one.
PGPORT="${PGPORT:-5432}"
# `$DB` resolves over the user-defined network below; 5432 is the container port.
DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${DB}:5432/${POSTGRES_DB}"

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

# ── network ────────────────────────────────────────────────────
# A user-defined network, because that is what gives containers DNS: on it the app
# resolves `packripper-db` by name. The default bridge does not do that, and
# hardcoding an IP would break on every restart.
ensure_network() {
	$ENGINE network inspect "$NET" >/dev/null 2>&1 && return 0
	say "creating network $NET"
	$ENGINE network create "$NET" >/dev/null
	ok "network created"
}

# ── database ───────────────────────────────────────────────────
ensure_db_volume() {
	$ENGINE volume inspect "$DB_VOLUME" >/dev/null 2>&1 && return 0
	say "creating volume $DB_VOLUME"
	$ENGINE volume create "$DB_VOLUME" >/dev/null
	ok "volume created"
}

start_db() {
	ensure_network
	ensure_db_volume

	if running "$DB"; then
		ok "database already up"
		return 0
	fi
	if exists "$DB"; then $ENGINE rm -f "$DB" >/dev/null; fi

	say "starting $DB"
	# No --user here, unlike the app. The postgres entrypoint starts as root
	# specifically so it can chown its data directory and then step down to the
	# postgres user itself; forcing a uid stops it doing either and initdb fails.
	$ENGINE run -d \
		--name "$DB" \
		--restart unless-stopped \
		--network "$NET" \
		--publish "127.0.0.1:${PGPORT}:5432" \
		--env "POSTGRES_USER=${POSTGRES_USER}" \
		--env "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
		--env "POSTGRES_DB=${POSTGRES_DB}" \
		--volume "${DB_VOLUME}:/var/lib/postgresql/data" \
		"$DB_IMAGE" >/dev/null
	ok "database container up"
}

db_ready() {
	$ENGINE exec "$DB" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q 2>/dev/null
}

# The app exits if it cannot reach Postgres, and it retries for 30s before doing
# so — but waiting here means a first run does not spend those retries printing
# alarming lines about a database that is merely still running initdb.
wait_for_db() {
	say "waiting for Postgres"
	local i
	for i in $(seq 1 90); do
		if db_ready; then
			ok "database ready after ${i}s"
			return 0
		fi
		if ! running "$DB"; then
			$ENGINE logs --tail 30 "$DB" >&2 || true
			die "the database container stopped while starting"
		fi
		sleep 1
	done
	$ENGINE logs --tail 30 "$DB" >&2 || true
	die "Postgres did not become ready within 90s"
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
		--network "$NET" \
		"${USER_ARGS[@]}" \
		--env "NODE_ENV=production" \
		--env "DATABASE_URL=${DATABASE_URL}" \
		--env "HOST=0.0.0.0" \
		--env "PORT=3000" \
		--env "BODY_SIZE_LIMIT=${BODY_SIZE_LIMIT}" \
		--env "ORIGIN=http://localhost:${PORT}" \
		--env "ADMIN_TOKEN=${ADMIN_TOKEN}" \
		--env "ADMIN_USERNAMES=${ADMIN_USERNAMES}" \
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
	printf '\n  %sLocal:%s     http://localhost:%s\n' "$B" "$N" "$PORT"
	printf '  %sPostgres:%s  postgres://%s@localhost:%s/%s\n' "$B" "$N" "$POSTGRES_USER" "$PGPORT" "$POSTGRES_DB"
	printf '  %s(public hosting is a Raspberry Pi — see deploy/pi/)%s\n\n' "$DIM" "$N"
}

# ── commands ───────────────────────────────────────────────────
cmd_up() {
	ensure_image
	start_db
	wait_for_db
	start_app
	wait_for_app
	print_url
}

# Removes the containers and leaves the volume alone. That asymmetry is the point:
# `down` is something you type a dozen times a day and it must not be the command
# that loses every account. `reset` is the one that can.
cmd_down() {
	if exists "$APP"; then $ENGINE rm -f "$APP" >/dev/null && ok "removed $APP"; fi
	if exists "$DB"; then $ENGINE rm -f "$DB" >/dev/null && ok "removed $DB (volume $DB_VOLUME kept)"; fi
}

cmd_reset() {
	printf 'This deletes volume %s and every account in it. Type "yes" to go ahead: ' "$DB_VOLUME"
	local answer; read -r answer
	[ "$answer" = yes ] || die "cancelled"
	cmd_down
	$ENGINE volume rm "$DB_VOLUME" >/dev/null 2>&1 && ok "volume removed" || warn "no volume to remove"
	cmd_up
}

cmd_psql() {
	running "$DB" || die "the database is not running — ./run.sh up first"
	$ENGINE exec -it "$DB" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
}

cmd_dump() {
	running "$DB" || die "the database is not running — ./run.sh up first"
	local out=${1:-packripper-$(date +%Y%m%d-%H%M%S).sql}
	say "dumping to $out"
	# --clean --if-exists so the dump can be replayed over an existing database
	# without hand-dropping it first.
	$ENGINE exec "$DB" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists > "$out"
	ok "wrote $out ($(du -h "$out" | cut -f1))"
}

cmd_status() {
	$ENGINE ps --filter "name=${APP}" --filter "name=${DB}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
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
	reset)   cmd_reset ;;
	build)   [ -n "$FORCE_BUILD" ] || build_image ;;
	pull)    pull_image ;;
	psql)    cmd_psql ;;
	dump)    cmd_dump "${2:-}" ;;
	logs)    if [ "${2:-}" = db ]; then $ENGINE logs -f "$DB"; else $ENGINE logs -f "$APP"; fi ;;
	url)     print_url ;;
	status)  cmd_status ;;
	shell)   $ENGINE exec -it "$APP" sh ;;
	-h|--help|help) usage ;;
	*)       die "unknown command '$1' — try ./run.sh --help" ;;
esac
