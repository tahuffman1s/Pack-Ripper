#!/usr/bin/env bash
#
# Hourly off-box backup of the database to a Nextcloud, over WebDAV.
#
# Takes a pg_dump of the Postgres container and uploads it gzipped. To restore:
#
#   gzip -dc db-h13.sql.gz | docker exec -i packripper-db \
#     psql -U packripper -d packripper
#
# Installed as a systemd timer by install.sh; runnable by hand any time:
#
#   ./backup.sh            # back up now
#   ./backup.sh --test     # prove the credentials work, upload nothing real
#
# Reads its settings from .env beside this file — the same file compose uses.
# NEXTCLOUD_URL empty (or absent) means backups are off and this exits quietly,
# so the timer can be installed before the credentials are.
#
# ── Retention, without any pruning logic ───────────────────────
#
# Every run writes to a slot named after the hour, and the 04:00 run also writes
# to a slot named after the weekday. So the remote holds 24 hourly files and 7
# daily ones, each overwritten as it comes round again — 31 files, forever, with
# nothing to delete and no directory listing to parse. You always have the last
# day at hourly granularity and the last week at daily.
#
# The alternative (timestamped names plus a prune step) needs PROPFIND and XML
# parsing to find what to delete, and fails by filling the remote silently.

set -euo pipefail

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=$HERE/.env
TEST_ONLY=0

case ${1:-} in
	--test) TEST_ONLY=1 ;;
	'') ;;
	*) echo "usage: $(basename "$0") [--test]" >&2; exit 2 ;;
esac

log() { printf '%s packripper-backup: %s\n' "$(date -Is)" "$*"; }
die() { printf '%s packripper-backup: %s\n' "$(date -Is)" "$*" >&2; exit 1; }

# Read only the keys we need, rather than sourcing: this file holds credentials
# and is not a shell script.
env_get() {
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

NEXTCLOUD_URL=${NEXTCLOUD_URL:-$(env_get NEXTCLOUD_URL)}
NEXTCLOUD_USER=${NEXTCLOUD_USER:-$(env_get NEXTCLOUD_USER)}
NEXTCLOUD_PASS=${NEXTCLOUD_PASS:-$(env_get NEXTCLOUD_PASS)}
NEXTCLOUD_PATH=${NEXTCLOUD_PATH:-$(env_get NEXTCLOUD_PATH)}
POSTGRES_USER=${POSTGRES_USER:-$(env_get POSTGRES_USER)}
POSTGRES_DB=${POSTGRES_DB:-$(env_get POSTGRES_DB)}
DB_CONTAINER=${DB_CONTAINER:-packripper-db}

[ -n "$NEXTCLOUD_URL" ] || { log 'NEXTCLOUD_URL is not set — backups are off'; exit 0; }
[ -n "$NEXTCLOUD_USER" ] || die 'NEXTCLOUD_USER is not set'
[ -n "$NEXTCLOUD_PASS" ] || die 'NEXTCLOUD_PASS is not set'
[ -n "$NEXTCLOUD_PATH" ] || NEXTCLOUD_PATH=PackRipper
[ -n "$POSTGRES_USER" ] || POSTGRES_USER=packripper
[ -n "$POSTGRES_DB" ] || POSTGRES_DB=packripper

# Whichever engine is installed. Only used to reach into the database container;
# the backup never touches the host filesystem where the data actually lives.
if command -v docker >/dev/null 2>&1; then
	ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
	ENGINE=podman
else
	die 'neither docker nor podman is installed'
fi

# Nextcloud's per-user WebDAV root. Trailing slashes trimmed off both parts so
# https://cloud.example.com/ and .../ both compose correctly.
base=${NEXTCLOUD_URL%/}
remote_dir="$base/remote.php/dav/files/$NEXTCLOUD_USER/${NEXTCLOUD_PATH#/}"
remote_dir=${remote_dir%/}

# The password never appears in argv — `ps` on a shared box would show it —
# so it goes to curl as a config file on stdin instead.
curl_dav() { # curl_dav METHOD_ARGS...
	printf 'user = "%s:%s"\n' "$NEXTCLOUD_USER" "$NEXTCLOUD_PASS" |
		curl -sS -K - --connect-timeout 20 --max-time 600 --retry 2 "$@"
}

# The status of a request, or 000 if it never got one. `-w '%{http_code}'` prints
# 000 by itself when the connection fails, so appending another on curl's exit
# status is how you get the nonsense "000000".
dav_code() { # dav_code ARGS...
	local out=
	out=$(curl_dav -o /dev/null -w '%{http_code}' "$@") || true
	printf '%s' "${out:-000}"
}

# ── reachable, and are the credentials right? ──────────────────
# A HEAD of the user's own WebDAV root: 401 tells you the app password is wrong,
# which is worth separating from "the upload failed".
code=$(dav_code "$base/remote.php/dav/files/$NEXTCLOUD_USER/" -X PROPFIND -H 'Depth: 0')
case $code in
	207 | 200) : ;;
	401) die "Nextcloud rejected the credentials (401). Use an app password from
                    Settings -> Security -> Devices & sessions, not your login password." ;;
	000) die "could not reach $base — no network, a wrong URL, or a TLS error (curl's
                    own message is above, if it printed one)" ;;
	403) die "authenticated, but 403 on the user's own WebDAV root. Is NEXTCLOUD_USER
                    ($NEXTCLOUD_USER) the right account for that app password?" ;;
	404 | 405 | 501) die "$base answers, but there is no WebDAV at remote.php/dav (HTTP $code).
                    NEXTCLOUD_URL should be the Nextcloud root and nothing more, e.g.
                    https://cloud.example.com — no /index.php, no /apps/files." ;;
	*) die "unexpected $code from $base/remote.php/dav — check the URL and the user" ;;
esac

# MKCOL is not idempotent: 201 created, 405 already there. Both are fine, and
# only both.
code=$(dav_code -X MKCOL "$remote_dir/")
case $code in
	201 | 405) : ;;
	409) die "the parent of $NEXTCLOUD_PATH does not exist on the remote — create the
                    folders above it, or use a single-level path" ;;
	*) die "could not create $remote_dir (HTTP $code)" ;;
esac

if [ "$TEST_ONLY" = 1 ]; then
	probe=$remote_dir/.packripper-write-test
	printf 'written by backup.sh --test\n' > /tmp/packripper-write-test.$$
	trap 'rm -f /tmp/packripper-write-test.$$' EXIT
	code=$(dav_code -T /tmp/packripper-write-test.$$ "$probe")
	case $code in
		201 | 204) log "upload works: $remote_dir is writable" ;;
		*) die "the folder exists but the upload failed (HTTP $code)" ;;
	esac
	curl_dav -o /dev/null -X DELETE "$probe" || true
	exit 0
fi

# ── the backup itself ──────────────────────────────────────────
#
# pg_dump, not a tar of the data directory. Two reasons, and the second is the
# one that matters:
#
#   1. A dump is a stream of SQL that any Postgres can restore, including a newer
#      major version. A copy of PGDATA is only readable by the exact major that
#      wrote it, which makes it useless precisely when you need it most — restoring
#      onto a fresh machine you have just installed the current Postgres on.
#   2. pg_dump runs in a single transaction and sees ONE consistent snapshot. A tar
#      of a live data directory does not: it reads files over several seconds while
#      the server writes to them, and what comes out is a torn copy that may not
#      restore at all. (The old JSON database got away with tar only because it was
#      replaced by rename, so tar saw one whole version or the other.)
#
# Neither needs the app stopped.
$ENGINE container inspect "$DB_CONTAINER" >/dev/null 2>&1 ||
	die "no container named $DB_CONTAINER — is the stack up?"

tmp=$(mktemp -t packripper-db-XXXXXX.sql.gz)
trap 'rm -f "$tmp"' EXIT

# --clean --if-exists so the dump can be replayed over a populated database
# without dropping it by hand first.
#
# No -t and no -T. `docker compose exec` has a -T meaning "no TTY", but plain
# `docker exec` and `podman exec` do not: they allocate no terminal unless asked,
# and podman rejects -T outright with exit 125. There is no terminal in a systemd
# timer either way.
#
# PIPESTATUS because `set -o pipefail` would report gzip's success; it is pg_dump
# failing that has to be caught, and it fails by writing a short file that gzip
# compresses perfectly happily.
set +o pipefail
$ENGINE exec "$DB_CONTAINER" \
	pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists 2>/tmp/pgdump-err.$$ |
	gzip -9 > "$tmp"
dump_status=${PIPESTATUS[0]}
set -o pipefail
if [ "$dump_status" != 0 ]; then
	die "pg_dump failed: $(tr '\n' ' ' < /tmp/pgdump-err.$$ | tail -c 300)"
fi
rm -f /tmp/pgdump-err.$$

size=$(wc -c < "$tmp")
# A gzip of nothing is still ~20 bytes, and a dump of an empty database is a few
# hundred of comments and SET statements. Either would upload happily and look
# like a backup, so the floor is well above both.
[ "$size" -gt 2000 ] || die "the dump came out suspiciously small ($size bytes) — not uploading it"

# Prove it is a complete dump and not a truncated stream. pg_dump writes this
# marker once, at the very end, so finding it anywhere means the pipe did not die
# halfway through.
#
# Deliberately grepping the WHOLE stream rather than `tail -n`: what follows the
# marker is version-dependent. Postgres 17.6 added a trailing `\unrestrict` line
# after it, which is exactly the kind of change that makes a `tail -3` start
# failing on a working backup after an image bump.
gzip -dc "$tmp" | grep -q 'PostgreSQL database dump complete' ||
	die 'the dump has no completion marker — it was truncated'

hour=$(date -u +%H)
dow=$(date -u +%u)

upload() { # upload REMOTE_NAME
	local code
	code=$(dav_code -T "$tmp" "$remote_dir/$1")
	case $code in
		201 | 204) log "uploaded $1 ($((size / 1024)) KiB)" ;;
		507) die "the Nextcloud is out of quota — $1 not saved" ;;
		*) die "upload of $1 failed (HTTP $code)" ;;
	esac
}

upload "db-h$hour.sql.gz"

# Spelled out rather than `[ ... ] && upload`, whose non-zero result on the other
# 23 hours is exactly the kind of thing `set -e` argues about.
if [ "$hour" = 04 ]; then
	upload "db-d$dow.sql.gz"
fi

exit 0
