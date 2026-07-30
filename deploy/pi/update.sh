#!/usr/bin/env bash
#
# Move PackRipper onto the image currently published, and stay on the old one if
# the new one does not come up.
#
#   ./update.sh            # update now, if there is anything to update to
#   ./update.sh --check    # say whether there is, change nothing running
#   ./update.sh --force    # recreate the app even if the image is unchanged
#
# install.sh puts this on a systemd timer (packripper-update.timer), which is
# what makes a push to main reach the Pi by itself. There is no webhook: GHCR
# does not offer one, and a Pi behind a tunnel has nothing for it to call anyway.
# So this polls — a manifest request every few minutes, which costs nothing.
#
# ── What it will not do ────────────────────────────────────────
#
# Nothing here touches the database. The app is a container over a bind mount and
# Postgres is a different service entirely: the swap replaces the app container
# and leaves DB_DIR, CACHE_DIR, .env and the db container exactly where they are.
# `db` is deliberately never pulled — it is pinned to a Postgres major because a
# newer one will not read the data directory an older one wrote, so bumping it
# needs a dump in hand and a person watching, not a timer.
#
# ── Why it waits, and what happens if it goes wrong ────────────
#
# An unattended update that leaves the site down until someone notices is worse
# than no unattended update. So after the swap this waits for /api/health, and if
# the new image does not answer it re-tags the previous one, brings that back,
# and records the bad image ID in .update-skip so the next run does not walk into
# the same wall every fifteen minutes. Remove that file (or pass --force) to try
# a recorded-bad build again.

set -euo pipefail

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=$HERE/.env
COMPOSE_FILE=$HERE/compose.yml
APP_CONTAINER=${APP_CONTAINER:-packripper}
SKIP_FILE=$HERE/.update-skip
LOCK_FILE=$HERE/.update.lock

CHECK_ONLY=0
FORCE=0
DO_BACKUP=1
# Four minutes. A warm .cache boots in seconds; this is sized for a slow Pi
# applying a schema change on a cold morning, not for the normal case. From the
# environment so a slower box can be given longer without editing this.
HEALTH_TRIES=${HEALTH_TRIES:-60}
HEALTH_SLEEP=${HEALTH_SLEEP:-4}

usage() {
	cat <<'EOF'
Update PackRipper to the published image, with a rollback if it will not start.

  --check        report whether a newer image exists, then stop. Note this still
                 downloads it — the registry has no cheaper way to be sure.
  --force        recreate the app even if the image has not changed, and ignore
                 .update-skip
  --no-backup    skip the pre-update database backup
  -h, --help

Reads .env beside this file, the same one compose uses.
EOF
}

while [ $# -gt 0 ]; do
	case $1 in
		--check) CHECK_ONLY=1; shift ;;
		--force) FORCE=1; shift ;;
		--no-backup) DO_BACKUP=0; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
	esac
done

log() { printf '%s packripper-update: %s\n' "$(date -Is)" "$*"; }
die() { printf '%s packripper-update: %s\n' "$(date -Is)" "$*" >&2; exit 1; }

# Read the keys we need rather than sourcing: .env holds credentials and is not
# a shell script.
env_get() {
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

short() { printf '%s' "${1#sha256:}" | cut -c1-12; }

[ -f "$COMPOSE_FILE" ] || die "no compose.yml beside this script ($HERE)"

# Two runs at once — a timer firing while someone runs this by hand — would race
# on the same containers. Best effort: if the lock file cannot be opened (root
# made it and we are not root) carry on unlocked rather than refuse to update.
if command -v flock >/dev/null 2>&1 && : >>"$LOCK_FILE" 2>/dev/null; then
	exec 9>>"$LOCK_FILE"
	flock -n 9 || { log 'another update is already running — leaving it to that one'; exit 0; }
fi

# Same reasoning as install.sh: group membership does not apply to a shell that
# already exists, and the timer runs as root where none of this is needed.
D=(docker)
command -v docker >/dev/null 2>&1 || die 'docker is not installed'
if ! docker info >/dev/null 2>&1; then
	if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
		D=(sudo -n docker)
	else
		die "cannot talk to the docker daemon as $(id -un). Run this as root, or log
                    out and back in if install.sh just added you to the docker group."
	fi
fi

compose() { "${D[@]}" compose --project-directory "$HERE" -f "$COMPOSE_FILE" "$@"; }

image_id() { "${D[@]}" image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
container_image() { "${D[@]}" inspect --format '{{.Image}}' "$APP_CONTAINER" 2>/dev/null || true; }

# Ask compose what the app's image is, so the tag comes from .env and the
# registry path is not written down twice. Filtering on the name rather than
# taking the first line, because `config --images` with a service filter is not
# supported by every compose 2.x.
app_ref() {
	local ref=
	ref=$(compose config --images 2>/dev/null | grep -m1 -i 'pack-ripper' || true)
	if [ -z "$ref" ]; then
		local tag
		tag=$(env_get TAG)
		[ -n "$tag" ] || tag=latest
		ref=ghcr.io/tahuffman1s/pack-ripper:$tag
	fi
	printf '%s' "$ref"
}

healthy() {
	"${D[@]}" exec "$APP_CONTAINER" curl -fsS -o /dev/null \
		http://127.0.0.1:3000/api/health >/dev/null 2>&1
}

wait_healthy() {
	local i
	for i in $(seq 1 "$HEALTH_TRIES"); do
		healthy && return 0
		sleep "$HEALTH_SLEEP"
	done
	return 1
}

REF=$(app_ref)
case $REF in
	*:sha-* | *:v*)
		# Not an error: pinning is the right thing to do, and a pinned tag simply
		# never moves. Worth one line in the journal so nobody wonders why the
		# timer has been running all week and nothing has changed.
		log "note: $REF is a pinned tag, so it will not move on its own"
		;;
esac

RUNNING=$(container_image)
log "checking $REF"
compose pull app ||
	die 'could not pull — registry unreachable, or the tag does not exist. Nothing changed.'

NEW=$(image_id "$REF")
[ -n "$NEW" ] || die "pulled, but $REF is somehow not here. Nothing changed."

if [ "$NEW" = "$RUNNING" ] && [ "$FORCE" = 0 ]; then
	log "already running the published image ($(short "$NEW"))"
	exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
	if [ -z "$RUNNING" ]; then
		log "the app is not running. $REF is here ($(short "$NEW")); ./update.sh would start it"
	else
		log "an update is available: $(short "$RUNNING") -> $(short "$NEW"). Apply it with ./update.sh"
	fi
	exit 0
fi

if [ "$FORCE" = 0 ] && [ -f "$SKIP_FILE" ] && grep -qxF "$NEW" "$SKIP_FILE" 2>/dev/null; then
	log "$(short "$NEW") failed to start here on an earlier run and was rolled back;
                    not trying it again. Delete $SKIP_FILE, or run with --force, to retry."
	exit 0
fi

# A container swap does not touch the data, but a new build can carry a schema
# change, and that is exactly the moment to have an hour-old dump off the Pi.
# A failure here is loud but not fatal: a Nextcloud being down is not a reason to
# stop updating forever.
if [ "$DO_BACKUP" = 1 ] && [ -x "$HERE/backup.sh" ] && [ -n "$(env_get NEXTCLOUD_URL)" ]; then
	log 'taking a backup before the swap'
	"$HERE/backup.sh" || log 'WARNING: the pre-update backup failed — updating anyway (see above)'
fi

if [ -n "$RUNNING" ]; then
	log "updating: $(short "$RUNNING") -> $(short "$NEW")"
else
	log "starting on $(short "$NEW")"
fi

# Only the app. `up -d app` still starts db if it is down, because of depends_on,
# but it never pulls or recreates it for a version it did not ask for.
compose up -d app

if wait_healthy; then
	log "updated and answering on $(short "$NEW")"
	# The superseded image is now untagged and is a couple of hundred megabytes
	# on a disk that may be an SD card. GHCR keeps every build, and going back is
	# `TAG=sha-<short>` in .env, so nothing is lost by dropping the local copy.
	if [ -n "$RUNNING" ] && [ "$RUNNING" != "$NEW" ]; then
		if "${D[@]}" image rm "$RUNNING" >/dev/null 2>&1; then
			log "removed the superseded image $(short "$RUNNING")"
		fi
	fi
	exit 0
fi

log "the new image did not answer /api/health in $((HEALTH_TRIES * HEALTH_SLEEP))s"

if [ -z "$RUNNING" ] || ! "${D[@]}" image inspect "$RUNNING" >/dev/null 2>&1; then
	die "and there is no previous image to go back to. The stack is on $(short "$NEW")
                    and not answering — ${D[*]} compose logs app"
fi

# Re-point the tag at the image that was working and recreate from it. The
# container stores the image ID it was created with, so this survives a reboot
# even though a later pull will move the tag forward again.
log "rolling back to $(short "$RUNNING")"
"${D[@]}" image tag "$RUNNING" "$REF"
compose up -d --force-recreate app
if wait_healthy; then
	log 'rolled back — the previous image is answering again'
else
	log "the rollback is not answering either. This is not the new image's fault;
                    look at ${D[*]} compose logs app and at the db container."
fi

grep -qxF "$NEW" "$SKIP_FILE" 2>/dev/null || printf '%s\n' "$NEW" >> "$SKIP_FILE"
log "recorded $(short "$NEW") as bad; it will be skipped until $SKIP_FILE is removed"
exit 1
