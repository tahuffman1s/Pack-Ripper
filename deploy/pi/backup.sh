#!/usr/bin/env bash
#
# Hourly off-box backup of the database to a Nextcloud, over WebDAV.
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
DATA_DIR=${DATA_DIR:-$(env_get DATA_DIR)}

[ -n "$NEXTCLOUD_URL" ] || { log 'NEXTCLOUD_URL is not set — backups are off'; exit 0; }
[ -n "$NEXTCLOUD_USER" ] || die 'NEXTCLOUD_USER is not set'
[ -n "$NEXTCLOUD_PASS" ] || die 'NEXTCLOUD_PASS is not set'
[ -n "$DATA_DIR" ] || DATA_DIR=$HERE/.data
[ -n "$NEXTCLOUD_PATH" ] || NEXTCLOUD_PATH=PackRipper

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
[ -d "$DATA_DIR" ] || die "$DATA_DIR does not exist"

tmp=$(mktemp -t packripper-db-XXXXXX.tar.gz)
trap 'rm -f "$tmp"' EXIT

# db.js writes db.json by rename, so tar either sees the old complete file or
# the new one — never a half-written one. No need to stop the app.
tar czf "$tmp" -C "$DATA_DIR" . 2>/dev/null ||
	die "could not read $DATA_DIR (permissions?)"
size=$(wc -c < "$tmp")
[ "$size" -gt 0 ] || die 'the archive came out empty'

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

upload "db-h$hour.tar.gz"

# Spelled out rather than `[ ... ] && upload`, whose non-zero result on the other
# 23 hours is exactly the kind of thing `set -e` argues about.
if [ "$hour" = 04 ]; then
	upload "db-d$dow.tar.gz"
fi

exit 0
