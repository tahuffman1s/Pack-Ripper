#!/usr/bin/env bash
#
# PackRipper on a Raspberry Pi, from a fresh 64-bit OS to a live public URL.
#
#   curl -fsSL https://raw.githubusercontent.com/tahuffman1s/Pack-Ripper/main/deploy/pi/install.sh | bash
#
# or, from a checkout:
#
#   ./deploy/pi/install.sh
#
# Safe to re-run, and re-running IS the update: it installs what is missing,
# keeps every answer already in .env, pulls the published image and recreates the
# containers on it. Nothing it does touches the database, the cache or the
# credentials — those live in bind mounts and .env, both of which it leaves
# alone. `./install.sh --update` is the same thing with the questions skipped.
#
# Nothing here is Pi-specific except the storage advice — it works on any arm64
# Debian or Ubuntu.
#
# What it does NOT do is create the Cloudflare tunnel for you. That needs a
# dashboard login, and the token it produces is the one thing this script cannot
# invent; it prints the three clicks and waits. See ../../README.md § Hosting it
# on a Raspberry Pi.

set -euo pipefail

REPO_URL=https://github.com/tahuffman1s/Pack-Ripper.git
RAW_URL=https://raw.githubusercontent.com/tahuffman1s/Pack-Ripper/main

DOMAIN=${DOMAIN:-}
TUNNEL_TOKEN=${TUNNEL_TOKEN:-}
ADMIN_USERNAMES=${ADMIN_USERNAMES:-}
ADMIN_TOKEN=${ADMIN_TOKEN:-}
DATA_DIR=${DATA_DIR:-}
CACHE_DIR=${CACHE_DIR:-}
DB_DIR=${DB_DIR:-}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}
NEXTCLOUD_URL=${NEXTCLOUD_URL:-}
NEXTCLOUD_USER=${NEXTCLOUD_USER:-}
NEXTCLOUD_PASS=${NEXTCLOUD_PASS:-}
NEXTCLOUD_PATH=${NEXTCLOUD_PATH:-}
TAG=${TAG:-latest}
AUTO_UPDATE=${AUTO_UPDATE:-}
UPDATE_INTERVAL=${UPDATE_INTERVAL:-}
TARGET_DIR=${TARGET_DIR:-$HOME/Pack-Ripper}
ASSUME_YES=0
DRY_RUN=0
DIR_EXPLICIT=0
NO_BACKUP=0
UPDATE_ONLY=0

# ── output ─────────────────────────────────────────────────────
if [ -t 1 ]; then
	B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
	B=; DIM=; R=; G=; Y=; N=
fi
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$*" "$N"; }
say()  { printf '    %s\n' "$*"; }
ok()   { printf '%s  ok%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s warn%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%sfail%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
shortid() { printf '%s' "${1#sha256:}" | cut -c1-12; }

# Every privileged or network-touching action goes through this, so --dry-run is
# a real audit of what the script would do rather than a second code path that
# drifts from the first.
run() {
	if [ "$DRY_RUN" = 1 ]; then
		printf '%s  would run:%s %s\n' "$DIM" "$N" "$*"
		return 0
	fi
	"$@"
}

# Write a file as root from stdin. Not `run "${SUDO[@]}" tee X >/dev/null`: that
# redirect silences run()'s own "would run" line, so a dry run showed nothing.
install_file() { # install_file PATH   (content on stdin)
	if [ "$DRY_RUN" = 1 ]; then
		printf '%s  would write:%s %s\n' "$DIM" "$N" "$1"
		cat >/dev/null    # the heredoc still has to be consumed
		return 0
	fi
	"${SUDO[@]}" tee "$1" >/dev/null
}

usage() {
	cat <<'EOF'
PackRipper installer for a Raspberry Pi (64-bit).

  --domain NAME          public hostname, e.g. packripper.example.com
  --token TOKEN          Cloudflare tunnel token (or set TUNNEL_TOKEN)
  --admin-user NAMES     comma-separated accounts that get the admin panel
  --admin-token TOKEN    shared secret for the admin CLI (generated if unset)
  --db-dir PATH          where Postgres stores the database (default: <dir>/deploy/pi/.pgdata)
  --data-dir PATH        legacy db.json to import, if any   (default: <dir>/deploy/pi/.data)
  --cache-dir PATH       where the API cache lives  (default: <dir>/deploy/pi/.cache)
  --dir PATH             where to clone the repo    (default: ~/Pack-Ripper)
  --tag TAG              image tag to run           (default: latest)

Updating an install that is already here (data, .env and answers are kept):
  --update               pull the published image and recreate, asking nothing
  --auto-update          keep up to date by itself     (default: on)
  --no-auto-update       stop that, and remove the timer if one is installed
  --update-interval SPEC how often to look: 15m, 2h, hourly, daily, or any
                         systemd OnCalendar expression   (default: 15m)

Hourly off-box backup of the database to a Nextcloud (optional, all four or none):
  --nextcloud-url URL    server root, e.g. https://cloud.example.com
  --nextcloud-user NAME
  --nextcloud-pass PASS  an app password, not the login password
  --nextcloud-path PATH  remote folder                (default: PackRipper)
  --no-backup            skip the question entirely
  -y, --yes              accept defaults; never prompt
  --dry-run              print what would happen, change nothing
  -h, --help

Values already in deploy/pi/.env are reused, so a re-run needs no arguments.
EOF
}

while [ $# -gt 0 ]; do
	case $1 in
		--domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
		--token) TUNNEL_TOKEN=${2:?--token needs a value}; shift 2 ;;
		--admin-user | --admin-users) ADMIN_USERNAMES=${2:?--admin-user needs a value}; shift 2 ;;
		--admin-token) ADMIN_TOKEN=${2:?--admin-token needs a value}; shift 2 ;;
		--db-dir) DB_DIR=${2:?--db-dir needs a value}; shift 2 ;;
		--data-dir) DATA_DIR=${2:?--data-dir needs a value}; shift 2 ;;
		--cache-dir) CACHE_DIR=${2:?--cache-dir needs a value}; shift 2 ;;
		--dir) TARGET_DIR=${2:?--dir needs a value}; DIR_EXPLICIT=1; shift 2 ;;
		--tag) TAG=${2:?--tag needs a value}; shift 2 ;;
		--update) UPDATE_ONLY=1; ASSUME_YES=1; NO_BACKUP=1; shift ;;
		--auto-update) AUTO_UPDATE=on; shift ;;
		--no-auto-update) AUTO_UPDATE=off; shift ;;
		--update-interval) UPDATE_INTERVAL=${2:?--update-interval needs a value}; shift 2 ;;
		--nextcloud-url) NEXTCLOUD_URL=${2:?--nextcloud-url needs a value}; shift 2 ;;
		--nextcloud-user) NEXTCLOUD_USER=${2:?--nextcloud-user needs a value}; shift 2 ;;
		--nextcloud-pass) NEXTCLOUD_PASS=${2:?--nextcloud-pass needs a value}; shift 2 ;;
		--nextcloud-path) NEXTCLOUD_PATH=${2:?--nextcloud-path needs a value}; shift 2 ;;
		--no-backup) NO_BACKUP=1; shift ;;
		-y | --yes) ASSUME_YES=1; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) die "unknown option: $1 (try --help)" ;;
	esac
done

# Piped from curl, stdin is the script itself, so a plain `read` would eat the
# rest of the source. /dev/tty is the terminal regardless of what stdin is.
TTY=
if [ -r /dev/tty ] && [ "$ASSUME_YES" = 0 ]; then TTY=/dev/tty; fi

# ask VAR "prompt" [default]
#
# Passing a third argument — even an empty one — makes the answer optional, and
# is what lets --yes proceed without a terminal. Omitting it entirely means the
# value is required, so `install.sh -y` fails loudly on a missing token rather
# than bringing up a stack that can never be reached.
ask() {
	local __var=$1 __prompt=$2 __has_default=0 __default= __reply=
	if [ $# -ge 3 ]; then __has_default=1; __default=$3; fi
	if [ -z "$TTY" ]; then
		[ "$__has_default" = 1 ] ||
			die "no terminal to ask for $__var — pass it as a flag (see --help)"
		eval "$__var=\$__default"
		return 0
	fi
	if [ -n "$__default" ]; then
		printf '    %s [%s]: ' "$__prompt" "$__default" > "$TTY"
	else
		printf '    %s: ' "$__prompt" > "$TTY"
	fi
	IFS= read -r __reply < "$TTY" || __reply=
	[ -n "$__reply" ] || __reply=$__default
	eval "$__var=\$__reply"
}

confirm() { # confirm "question" -> 0 yes / 1 no
	[ -n "$TTY" ] || return 0
	local __reply=
	printf '    %s [Y/n]: ' "$1" > "$TTY"
	IFS= read -r __reply < "$TTY" || __reply=
	case $__reply in [nN]*) return 1 ;; *) return 0 ;; esac
}

# ── 1. preflight ───────────────────────────────────────────────
step 'Checking this machine'

[ "$(uname -s)" = Linux ] || die "this installs on Linux; found $(uname -s)"

arch=$(uname -m)
case $arch in
	aarch64 | arm64) ok "64-bit ARM ($arch)" ;;
	x86_64) warn "x86_64, not a Pi — fine, the image is a two-platform manifest" ;;
	armv7l | armv6l)
		die "this is a 32-bit userland ($arch). The image has no armv7 build and is not
      going to get one. Reflash with the 64-bit Raspberry Pi OS (or Ubuntu
      arm64) — on a Pi 4 that is the only supported choice here."
		;;
	*) warn "unrecognised architecture $arch; continuing anyway" ;;
esac

if [ -r /proc/device-tree/model ]; then
	# NUL-terminated in device-tree, hence the tr.
	ok "$(tr -d '\0' < /proc/device-tree/model)"
fi

mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
if [ "$mem_kb" -gt 0 ] && [ "$mem_kb" -lt 1600000 ]; then
	warn "only $((mem_kb / 1024)) MB of RAM. A Pi Zero 2 W cannot run this comfortably;
      2 GB is the floor and a Pi 4 is what this was written for."
fi

if [ "$(id -u)" = 0 ]; then
	SUDO=()
	RUN_USER=${SUDO_USER:-root}
else
	command -v sudo >/dev/null 2>&1 || die "not root and sudo is not installed"
	SUDO=(sudo)
	RUN_USER=$(id -un)
	# Prompt for the password once, up front, rather than in the middle of an
	# apt run where it looks like a hang.
	run "${SUDO[@]}" -v || die "sudo refused"
fi

# /run/systemd/system exists only when systemd is PID 1 — `command -v systemctl`
# is not the same question, and answering the wrong one is how a container or a
# WSL install ends up failing here instead of degrading.
HAVE_SYSTEMD=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
	HAVE_SYSTEMD=1
fi

# ── 2. base packages ───────────────────────────────────────────
step 'Installing git and curl if missing'

missing=()
for c in git curl; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
	say "missing: ${missing[*]}"
	run "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -qq
	run "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
		ca-certificates "${missing[@]}"
	[ "$DRY_RUN" = 1 ] || ok "installed ${missing[*]}"
else
	ok 'git and curl are present'
fi

# ── 3. docker ──────────────────────────────────────────────────
step 'Installing Docker if missing'

if command -v docker >/dev/null 2>&1; then
	ok "docker present: $(docker --version 2>/dev/null || echo unknown)"
else
	say 'fetching get.docker.com — this is the slow part, a few minutes on a Pi'
	run sh -c "curl -fsSL https://get.docker.com | ${SUDO[*]} sh"
	[ "$DRY_RUN" = 1 ] || ok 'docker installed'
fi

# The compose plugin is separate, and a docker installed from Debian's own
# docker.io package does not include it.
if ! run docker compose version >/dev/null 2>&1; then
	if [ "$DRY_RUN" = 0 ]; then
		say 'docker compose plugin missing; installing docker-compose-plugin'
		run "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
			docker-compose-plugin ||
			die "could not install the docker compose plugin. If docker came from
      Debian's docker.io package, remove it and re-run so get.docker.com can
      install Docker CE with the plugin."
	fi
fi

# Enabled, or a power cut is the end of the service — the whole point of a Pi
# host is that it comes back by itself.
if [ "$HAVE_SYSTEMD" = 1 ]; then
	run "${SUDO[@]}" systemctl enable --now docker 2>/dev/null ||
		warn 'could not enable the docker service — start it yourself'
else
	warn 'no systemd here, so Docker is not enabled at boot — arrange that yourself'
fi

# Group membership does not apply to a shell that already exists, so this run
# keeps using sudo even after adding it. Next login is when it takes effect.
DOCKER=(docker)
if [ "$(id -u)" != 0 ] && ! docker info >/dev/null 2>&1; then
	if ! id -nG "$RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
		run "${SUDO[@]}" usermod -aG docker "$RUN_USER"
		say "added $RUN_USER to the docker group — log out and back in for it to apply"
	fi
	DOCKER=(sudo docker)
fi
ok "using: ${DOCKER[*]}"

# ── 4. the repo ────────────────────────────────────────────────
step 'Fetching PackRipper'

# Already inside a checkout? Use it, so running ./deploy/pi/install.sh does not
# clone a second copy somewhere else.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$here/compose.yml" ] && [ -d "$here/../../.git" ]; then
	found=$(CDPATH= cd -- "$here/../.." && pwd)
	if [ "$DIR_EXPLICIT" = 1 ] && [ "$found" != "$TARGET_DIR" ]; then
		warn "ignoring --dir $TARGET_DIR: this script is being run from the checkout at
      $found, and that is the copy whose compose.yml would be used."
	fi
	TARGET_DIR=$found
	ok "using this checkout: $TARGET_DIR"
elif [ -d "$TARGET_DIR/.git" ]; then
	run git -C "$TARGET_DIR" pull --ff-only
	[ "$DRY_RUN" = 1 ] || ok "updated $TARGET_DIR"
else
	run git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
	[ "$DRY_RUN" = 1 ] || ok "cloned to $TARGET_DIR"
fi

DEPLOY_DIR=$TARGET_DIR/deploy/pi
if [ "$DRY_RUN" = 0 ] && [ ! -f "$DEPLOY_DIR/compose.yml" ]; then
	die "$DEPLOY_DIR/compose.yml is missing — is $TARGET_DIR really the repo?"
fi

# ── 5. where the data goes ─────────────────────────────────────
step 'Choosing storage'

ENV_FILE=$DEPLOY_DIR/.env
# Reuse what a previous run answered. Read the keys explicitly rather than
# sourcing the file: it holds two credentials and is not a shell script.
env_get() {
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}
[ -n "$DOMAIN" ] || DOMAIN=$(env_get DOMAIN)
[ -n "$TUNNEL_TOKEN" ] || TUNNEL_TOKEN=$(env_get TUNNEL_TOKEN)
[ -n "$ADMIN_USERNAMES" ] || ADMIN_USERNAMES=$(env_get ADMIN_USERNAMES)
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN=$(env_get ADMIN_TOKEN)
[ -n "$DATA_DIR" ] || DATA_DIR=$(env_get DATA_DIR)
[ -n "$CACHE_DIR" ] || CACHE_DIR=$(env_get CACHE_DIR)
[ -n "$DB_DIR" ] || DB_DIR=$(env_get DB_DIR)
[ -n "$POSTGRES_PASSWORD" ] || POSTGRES_PASSWORD=$(env_get POSTGRES_PASSWORD)
[ -n "$NEXTCLOUD_URL" ] || NEXTCLOUD_URL=$(env_get NEXTCLOUD_URL)
[ -n "$NEXTCLOUD_USER" ] || NEXTCLOUD_USER=$(env_get NEXTCLOUD_USER)
[ -n "$NEXTCLOUD_PASS" ] || NEXTCLOUD_PASS=$(env_get NEXTCLOUD_PASS)
[ -n "$NEXTCLOUD_PATH" ] || NEXTCLOUD_PATH=$(env_get NEXTCLOUD_PATH)
[ -n "$AUTO_UPDATE" ] || AUTO_UPDATE=$(env_get AUTO_UPDATE)
[ -n "$UPDATE_INTERVAL" ] || UPDATE_INTERVAL=$(env_get UPDATE_INTERVAL)
# On unless someone turned it off. A Pi nobody logs into is the whole point of
# this deployment, and an app that never gets the fix is the failure mode.
[ -n "$AUTO_UPDATE" ] || AUTO_UPDATE=on
[ -n "$UPDATE_INTERVAL" ] || UPDATE_INTERVAL=15m

# --update is for a machine that is already set up: it keeps everything and only
# moves the image forward. Refusing to run it against nothing is better than
# silently doing a first install with every answer defaulted.
if [ "$UPDATE_ONLY" = 1 ] && [ ! -f "$ENV_FILE" ]; then
	die "--update, but there is no $ENV_FILE to update. Run the installer without
      it (or with --domain/--token) to set this machine up first."
fi

root_dev=$(findmnt -no SOURCE / 2>/dev/null || echo '')
on_sd=0
case $root_dev in *mmcblk*) on_sd=1 ;; esac

if [ -z "$DB_DIR" ] && [ "$on_sd" = 1 ]; then
	warn "this Pi boots from an SD card ($root_dev)."
	say 'The database is Postgres, which writes the row that changed plus a WAL record —'
	say 'kilobytes per slot spin, where the old JSON file rewrote all ~4 MB of every'
	say 'account on every one. So this matters much less than it used to, and it still'
	say 'matters: a busy evening is steady small writes to one spot on a card with no'
	say 'wear-levelling worth the name. A USB SSD is the change that decides whether'
	say 'the storage lasts years instead of months.'

	# Suggest, never mount or format anything: picking the wrong disk and
	# formatting it is not a mistake a convenience script gets to make.
	candidates=$(lsblk -rno MOUNTPOINT,NAME,TYPE 2>/dev/null |
		awk '$3 == "part" && $1 != "" && $1 != "/" && $1 !~ /^\/boot/ && $2 !~ /^mmcblk/ { print $1 }' || true)
	if [ -n "$candidates" ]; then
		say ''
		say 'Mounted non-SD filesystems that look usable:'
		printf '      %s\n' $candidates
		ask picked 'Path for the database (blank = keep it on the SD card)' ''
		[ -z "$picked" ] || DB_DIR=$picked/packripper/.pgdata
		[ -z "$picked" ] || [ -n "$CACHE_DIR" ] || CACHE_DIR=$picked/packripper/.cache
	else
		say ''
		say 'No other disk is mounted. Attach one, mount it, and re-run with'
		say '  --db-dir /mnt/ssd/packripper/.pgdata --cache-dir /mnt/ssd/packripper/.cache'
		confirm 'Continue on the SD card for now?' || die 'stopped at your request'
	fi
fi

if [ -n "$DB_DIR" ]; then
	run mkdir -p "$DB_DIR"
	ok "database: $DB_DIR (Postgres)"
else
	ok "database: $DEPLOY_DIR/.pgdata (Postgres, on $root_dev)"
fi
if [ -n "$CACHE_DIR" ]; then
	run mkdir -p "$CACHE_DIR"
	ok "cache: $CACHE_DIR"
fi
# Only worth creating if there is an old database to carry across. An empty one
# is harmless — the app just finds nothing to import.
if [ -n "$DATA_DIR" ]; then
	run mkdir -p "$DATA_DIR"
	ok "legacy import dir: $DATA_DIR"
fi

# ── 6. the tunnel, and the rest of .env ────────────────────────
step 'Configuring'

if [ -z "$TUNNEL_TOKEN" ]; then
	cat <<EOF

    A Cloudflare tunnel token is needed, and only you can make one. The domain
    has to already be a zone in your Cloudflare account (free plan is fine,
    nameservers pointed at Cloudflare), then:

      1. dash.cloudflare.com -> Zero Trust -> Networks -> Tunnels
      2. Create a tunnel -> Cloudflared -> name it anything
      3. Copy the token: it is the long string after \`--token\` in the install
         command it shows you. Do not run that command.
      4. On the tunnel's Public Hostname tab, add your hostname and point it at
         ${B}http://localhost:3000${N}
         (localhost, not a service name — cloudflared shares the app's container)

EOF
	ask TUNNEL_TOKEN 'Tunnel token'
	[ -n "$TUNNEL_TOKEN" ] || die 'no token, no tunnel. Re-run with --token once you have one.'
fi

[ -n "$DOMAIN" ] || ask DOMAIN 'Public hostname (the one you routed above)'
[ -n "$DOMAIN" ] || die 'no hostname. The app needs it for ORIGIN or every login fails.'
case $DOMAIN in
	http*) die "give the hostname only, not a URL: ${DOMAIN#http*://}" ;;
	*.*) : ;;
	*) warn "\"$DOMAIN\" does not look like a hostname" ;;
esac

[ -n "$ADMIN_USERNAMES" ] || ask ADMIN_USERNAMES 'Admin account name (blank for none)' ''

# ── hourly backups to a Nextcloud (optional) ───────────────────
# One question before three, so the common answer costs one keystroke.
if [ -z "$NEXTCLOUD_URL" ] && [ -n "$TTY" ] && [ "$NO_BACKUP" = 0 ]; then
	say ''
	say 'An hourly backup of the database to a Nextcloud is what makes an SD card'
	say 'failure a reflash instead of a loss. Needs the server URL, a username, and'
	say 'an app password (Settings -> Security -> Devices & sessions).'
	if confirm 'Set up hourly backups to a Nextcloud?'; then
		ask NEXTCLOUD_URL 'Nextcloud URL (e.g. https://cloud.example.com)'
		ask NEXTCLOUD_USER 'Nextcloud username'
		ask NEXTCLOUD_PASS 'Nextcloud app password'
		ask NEXTCLOUD_PATH 'Folder to put them in' "${NEXTCLOUD_PATH:-PackRipper}"
	fi
fi
if [ -n "$NEXTCLOUD_URL" ]; then
	[ -n "$NEXTCLOUD_USER" ] || die 'NEXTCLOUD_URL given without --nextcloud-user'
	[ -n "$NEXTCLOUD_PASS" ] || die 'NEXTCLOUD_URL given without --nextcloud-pass'
	[ -n "$NEXTCLOUD_PATH" ] || NEXTCLOUD_PATH=PackRipper
	case $NEXTCLOUD_URL in
		http://* | https://*) : ;;
		*) die "NEXTCLOUD_URL needs a scheme: https://$NEXTCLOUD_URL" ;;
	esac
	case $NEXTCLOUD_URL in
		*/remote.php* | */index.php* | */apps/*)
			die "NEXTCLOUD_URL should be the server root, with no path inside Nextcloud —
      no /remote.php, /index.php or /apps. Usually https://cloud.example.com,
      or https://example.com/nextcloud if it is installed in a subdirectory."
			;;
	esac
fi

if [ -z "$ADMIN_TOKEN" ]; then
	if command -v openssl >/dev/null 2>&1; then
		ADMIN_TOKEN=$(openssl rand -hex 32)
	else
		ADMIN_TOKEN=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
	fi
	say 'generated an ADMIN_TOKEN'
fi

# Generated once and then reused from .env forever, because it is baked into the
# Postgres data directory at initdb time: changing it later does NOT change the
# password the server actually wants, and the app then cannot log in. Hex rather
# than base64 so there is no character a connection URL would need escaped.
if [ -z "$POSTGRES_PASSWORD" ]; then
	if command -v openssl >/dev/null 2>&1; then
		POSTGRES_PASSWORD=$(openssl rand -hex 24)
	else
		POSTGRES_PASSWORD=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
	fi
	say 'generated a POSTGRES_PASSWORD'
fi

# 0600 before a byte is written, not chmod'd after: this file holds a Cloudflare
# credential for your whole account and the admin secret for the app.
if [ "$DRY_RUN" = 1 ]; then
	printf '%s  would write:%s %s (0600)\n' "$DIM" "$N" "$ENV_FILE"
else
	(
		umask 077
		cat > "$ENV_FILE" <<EOF
# Written by deploy/pi/install.sh. Safe to edit; re-running the installer keeps
# whatever is in here. Mode 0600 — it holds three credentials.

DOMAIN=$DOMAIN
TUNNEL_TOKEN=$TUNNEL_TOKEN

TAG=$TAG
BODY_SIZE_LIMIT=2M

# Read by install.sh and update.sh, not by compose. AUTO_UPDATE=off leaves the
# timer uninstalled; the interval is a systemd OnCalendar, or 15m/2h/hourly/daily.
AUTO_UPDATE=$AUTO_UPDATE
UPDATE_INTERVAL=$UPDATE_INTERVAL

ADMIN_USERNAMES=$ADMIN_USERNAMES
ADMIN_TOKEN=$ADMIN_TOKEN

# Postgres. POSTGRES_PASSWORD is fixed at the moment the data directory is first
# created — editing it here afterwards locks the app out rather than rotating it.
# To actually change it: ALTER USER inside the container, then update this.
POSTGRES_USER=packripper
POSTGRES_DB=packripper
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
		[ -z "$DB_DIR" ] || echo "DB_DIR=$DB_DIR" >> "$ENV_FILE"
		[ -z "$DATA_DIR" ] || echo "DATA_DIR=$DATA_DIR" >> "$ENV_FILE"
		[ -z "$CACHE_DIR" ] || echo "CACHE_DIR=$CACHE_DIR" >> "$ENV_FILE"
		if [ -n "$NEXTCLOUD_URL" ]; then
			cat >> "$ENV_FILE" <<EOF

# Hourly backup target. backup.sh reads these; compose ignores them.
NEXTCLOUD_URL=$NEXTCLOUD_URL
NEXTCLOUD_USER=$NEXTCLOUD_USER
NEXTCLOUD_PASS=$NEXTCLOUD_PASS
NEXTCLOUD_PATH=$NEXTCLOUD_PATH
EOF
		fi
	)
	ok "wrote $ENV_FILE (0600)"
fi

# ── 7. up ──────────────────────────────────────────────────────
compose() {
	run "${DOCKER[@]}" compose --project-directory "$DEPLOY_DIR" \
		-f "$DEPLOY_DIR/compose.yml" "$@"
}

# What is running right now, if anything. Two things use it: the wording below,
# and the cleanup after the health check, which removes the image this one
# supersedes. Not in a dry run — `sudo docker` there would ask for a password
# this script has deliberately not asked for.
PREV_APP_IMAGE=
if [ "$DRY_RUN" = 0 ]; then
	PREV_APP_IMAGE=$("${DOCKER[@]}" inspect --format '{{.Image}}' packripper 2>/dev/null || true)
fi

if [ -n "$PREV_APP_IMAGE" ]; then
	step 'Updating the running stack'
	say 'the containers are replaced; the database, the cache and .env are not —'
	say 'they are bind mounts and a file, and nothing here writes to them.'
else
	step 'Starting'
fi

# Not fatal. A re-run on flaky wifi should still bring up the image already on
# the disk rather than abort because the registry was briefly unreachable.
compose pull || warn 'could not pull; using whatever image is already here'
# No -v, ever, and no `down` first: `up -d` recreates only the containers whose
# image or configuration actually changed, and leaves the volumes alone in every
# case. That is what makes re-running this an update rather than a reinstall.
compose up -d

# ── 8. wait for it ─────────────────────────────────────────────
if [ "$DRY_RUN" = 0 ]; then
step 'Waiting for the first boot'
say 'a cold cache fetches the Scryfall set list and probes ~55 sets for sealed'
say 'prices before it answers anything, so this takes a couple of minutes once'

app_ok=0
for _ in $(seq 1 90); do
	if "${DOCKER[@]}" exec packripper curl -fsS -o /dev/null \
		http://127.0.0.1:3000/api/health 2>/dev/null; then
		app_ok=1
		break
	fi
	sleep 4
done
if [ "$app_ok" = 1 ]; then
	ok 'the app is answering'
else
	warn "the app did not answer in six minutes. Look at:
      ${DOCKER[*]} compose --project-directory $DEPLOY_DIR logs app"
fi

# Only possible because cloudflared is in the image: /ready is 200 once at least
# one connection to Cloudflare's edge is registered.
tunnel_ok=0
for _ in $(seq 1 15); do
	if "${DOCKER[@]}" exec packripper curl -fsS -o /dev/null \
		http://127.0.0.1:2000/ready 2>/dev/null; then
		tunnel_ok=1
		break
	fi
	sleep 2
done
if [ "$tunnel_ok" = 1 ]; then
	ok 'the tunnel is connected to Cloudflare'
else
	warn "the tunnel is not connected. The token is the usual reason — check:
      ${DOCKER[*]} logs packripper 2>&1 | grep -i tunnel"
fi

# Say what the update actually did, and only then drop the image it replaced —
# which is now untagged and a couple of hundred megabytes on a disk that may
# still be an SD card. GHCR keeps every build, so going back is TAG=sha-<short>
# in .env and another run of this script.
NEW_APP_IMAGE=$("${DOCKER[@]}" inspect --format '{{.Image}}' packripper 2>/dev/null || true)
if [ -n "$PREV_APP_IMAGE" ] && [ "$PREV_APP_IMAGE" = "$NEW_APP_IMAGE" ]; then
	ok 'already on the published image — nothing to update'
elif [ -n "$PREV_APP_IMAGE" ] && [ -n "$NEW_APP_IMAGE" ]; then
	ok "updated: $(shortid "$PREV_APP_IMAGE") -> $(shortid "$NEW_APP_IMAGE")"
	if [ "$app_ok" = 1 ] && "${DOCKER[@]}" image rm "$PREV_APP_IMAGE" >/dev/null 2>&1; then
		say "removed the image it replaced ($(shortid "$PREV_APP_IMAGE"))"
	fi
fi

fi  # end of the wait, skipped by --dry-run

# ── 9. hourly backups ──────────────────────────────────────────
BACKUP_STATE=off
if [ -n "$NEXTCLOUD_URL" ] && [ "$HAVE_SYSTEMD" = 0 ]; then
	step 'Installing the hourly backup'
	warn "no systemd, so there is no timer to install. Add this to \`crontab -e\` instead:
        17 * * * * $DEPLOY_DIR/backup.sh >/dev/null"
	BACKUP_STATE=notimer
elif [ -n "$NEXTCLOUD_URL" ]; then
	step 'Installing the hourly backup'

	# A systemd timer rather than a cron line, for two reasons that matter on a
	# Pi: Persistent=true runs a run that was missed while the Pi was off, and
	# the output lands in the journal instead of in mail nobody reads.
	#
	# No User=, so it runs as root. The reason changed with the database but did
	# not go away: backup.sh no longer reads root-owned files out of a bind mount,
	# it runs pg_dump via `docker exec` — and talking to the Docker socket is the
	# same privilege by a different name. Running it as a normal user would mean
	# adding that user to the `docker` group, which grants root on the host anyway.
	install_file /etc/systemd/system/packripper-backup.service <<EOF
[Unit]
Description=PackRipper database backup to Nextcloud
Documentation=https://github.com/tahuffman1s/Pack-Ripper
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$DEPLOY_DIR/backup.sh
Nice=10
IOSchedulingClass=idle
EOF

	install_file /etc/systemd/system/packripper-backup.timer <<'EOF'
[Unit]
Description=Hourly PackRipper database backup

[Timer]
OnCalendar=hourly
# Catch up on a run missed while the Pi was off, rather than silently skipping
# to the next hour.
Persistent=true
# Not everyone's Pi hitting the same Nextcloud on the stroke of the hour. Well
# under an hour, so the hourly slot the backup writes to is still the right one.
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF

	run "${SUDO[@]}" systemctl daemon-reload ||
		warn 'systemctl daemon-reload failed'
	run "${SUDO[@]}" systemctl enable --now packripper-backup.timer 2>/dev/null ||
		warn 'could not enable the timer (no systemd?)'
	[ "$DRY_RUN" = 1 ] || ok 'timer installed: packripper-backup.timer, hourly'

	# Prove the credentials now, while someone is watching. A backup that only
	# fails at 3am is worse than no backup, because you believe you have one.
	if [ "$DRY_RUN" = 1 ]; then
		printf '%s  would run:%s %s --test, then take the first backup\n' \
			"$DIM" "$N" "$DEPLOY_DIR/backup.sh"
		BACKUP_STATE=on
	elif "$DEPLOY_DIR/backup.sh" --test; then
		BACKUP_STATE=on
		# And take one immediately, so there is a copy off the Pi before you
		# start playing rather than after the first hour.
		if "${SUDO[@]}" systemctl start packripper-backup.service; then
			ok 'first backup taken'
		else
			warn "the first backup failed — ${SUDO[*]} journalctl -u packripper-backup -n 30"
		fi
	else
		BACKUP_STATE=broken
		warn "the backup credentials did not work (message above). The timer is
      installed and will keep trying. Fix NEXTCLOUD_* in
      $ENV_FILE and check it with:
        $DEPLOY_DIR/backup.sh --test"
	fi
fi

# ── 10. staying up to date ─────────────────────────────────────
#
# A timer that polls, because there is no webhook to be had: GHCR does not send
# one, and a Pi behind a tunnel publishes no port for it to arrive on. A manifest
# request every quarter of an hour costs nothing and means a push to main is live
# here within about twenty minutes without anyone logging in.
#
# The work itself is update.sh, not `compose pull && up -d` inlined here, because
# an unattended update needs the part a person does by hand: wait for the new
# image to answer, and put the old one back if it does not.

# systemd wants an OnCalendar; people want to type "15m".
oncalendar() {
	case $1 in
		hourly | daily | weekly) printf '%s' "$1" ;;
		*[0-9]m) printf '*:0/%s' "${1%m}" ;;
		*[0-9]h) printf '0/%s:00' "${1%h}" ;;
		*) printf '%s' "$1" ;;
	esac
}

UPDATE_STATE=off
if [ "$AUTO_UPDATE" = off ]; then
	# "off" has to mean off on a machine that was set up with it on, or it only
	# means "off next time".
	if [ "$HAVE_SYSTEMD" = 1 ] && [ -f /etc/systemd/system/packripper-update.timer ]; then
		step 'Turning automatic updates off'
		run "${SUDO[@]}" systemctl disable --now packripper-update.timer 2>/dev/null || true
		run "${SUDO[@]}" rm -f /etc/systemd/system/packripper-update.timer \
			/etc/systemd/system/packripper-update.service
		run "${SUDO[@]}" systemctl daemon-reload || true
		[ "$DRY_RUN" = 1 ] || ok 'the timer is gone; updates are manual again'
	fi
elif [ "$HAVE_SYSTEMD" = 0 ]; then
	step 'Installing the auto-updater'
	warn "no systemd, so there is no timer to install. Add this to \`crontab -e\` instead:
        */15 * * * * $DEPLOY_DIR/update.sh >/dev/null"
	UPDATE_STATE=notimer
else
	step 'Installing the auto-updater'

	ONCALENDAR=$(oncalendar "$UPDATE_INTERVAL")
	if command -v systemd-analyze >/dev/null 2>&1; then
		systemd-analyze calendar "$ONCALENDAR" >/dev/null 2>&1 ||
			die "--update-interval $UPDATE_INTERVAL means OnCalendar=$ONCALENDAR, which systemd
      does not understand. Try 15m, 2h, hourly, daily, or a calendar expression
      that \`systemd-analyze calendar\` accepts."
	fi

	[ -x "$DEPLOY_DIR/update.sh" ] || run chmod +x "$DEPLOY_DIR/update.sh"

	# Root, for the same reason the backup unit is: it drives the Docker socket,
	# and access to that socket is root on the host under another name.
	install_file /etc/systemd/system/packripper-update.service <<EOF
[Unit]
Description=PackRipper update to the published image
Documentation=https://github.com/tahuffman1s/Pack-Ripper
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$DEPLOY_DIR/update.sh
# The pull, then up to four minutes waiting for the new image to answer, then
# possibly the same again rolling back. Generous, because being killed halfway
# through a rollback is the one outcome worse than a failed update.
TimeoutStartSec=1200
Nice=10
IOSchedulingClass=idle
EOF

	install_file /etc/systemd/system/packripper-update.timer <<EOF
[Unit]
Description=Look for a new PackRipper image

[Timer]
OnCalendar=$ONCALENDAR
# A Pi that was off through a release should update when it comes back, not wait
# for the next slot.
Persistent=true
# Not every Pi asking GHCR on the same tick, and it keeps the update off the
# stroke of the hour where the backup timer already is.
RandomizedDelaySec=3m

[Install]
WantedBy=timers.target
EOF

	run "${SUDO[@]}" systemctl daemon-reload || warn 'systemctl daemon-reload failed'
	run "${SUDO[@]}" systemctl enable --now packripper-update.timer 2>/dev/null ||
		warn 'could not enable the update timer'
	[ "$DRY_RUN" = 1 ] || ok "timer installed: packripper-update.timer, OnCalendar=$ONCALENDAR"
	UPDATE_STATE=on

	# A pinned tag never moves, so the timer would run forever and change nothing.
	# Worth saying out loud rather than leaving someone to wonder.
	case $TAG in
		latest) : ;;
		*) warn "TAG=$TAG is pinned, so automatic updates will find nothing to do.
      Set TAG=latest in $ENV_FILE to follow main." ;;
	esac
fi

if [ "$DRY_RUN" = 1 ]; then
	step 'Dry run finished — nothing was changed'
	exit 0
fi

# ── 11. what is left ───────────────────────────────────────────
step 'Done'
cat <<EOF

    ${B}https://$DOMAIN${N}

    That works as soon as the tunnel's Public Hostname routes to
    http://localhost:3000. If you get a 502 or a 1033, that route is what to
    check — not this Pi.

    ${B}Admin${N}
      ${DOCKER[*]} exec -it packripper admin status
      ${DOCKER[*]} exec -it packripper admin list
      ${DOCKER[*]} exec -it packripper admin gold ${ADMIN_USERNAMES:-someone} 5000
$([ -n "$ADMIN_USERNAMES" ] && printf '      %s gets the /admin panel from its next sign-in.' "$ADMIN_USERNAMES")

    ${B}Day to day${N}
      cd $DEPLOY_DIR
      ${DOCKER[*]} compose logs -f app   # 'db: loaded N account(s)' is the line to read
      ./update.sh                        # move to the published build now
      \$EDITOR .env                      # pin TAG=sha-<short> to know what is running

EOF

case $UPDATE_STATE in
	on)
		cat <<EOF
    ${B}Updates${N} — automatic, checked on OnCalendar=$ONCALENDAR
      A push to main builds an image; this Pi picks it up within the hour with no
      login. Only the app container is replaced — the database, the cache and
      .env are untouched, and \`db\` is never pulled, because a Postgres major
      bump needs a dump in hand rather than a timer.

      If a new build does not answer /api/health within four minutes, the old
      image is put back and the bad one is recorded in .update-skip so the next
      run does not walk into it again. Nothing is left down.

      ${SUDO[*]} systemctl list-timers packripper-update   # when it next looks
      ${SUDO[*]} journalctl -u packripper-update -n 30     # what it did
      ./update.sh --check                    # is there anything to move to?
      ./install.sh --no-auto-update          # stop doing this

EOF
		;;
	notimer)
		cat <<EOF
    ${B}Updates are manual on this machine.${N} There is no systemd here to hold a
    timer, so add the cron line printed above, or run it yourself when you want
    a new build:
      $DEPLOY_DIR/update.sh

EOF
		;;
	*)
		cat <<EOF
    ${B}Updates are manual.${N} Nothing polls for a new build; when you want one:
      $DEPLOY_DIR/update.sh
    Turn the timer on with:
      $DEPLOY_DIR/install.sh --update --auto-update

EOF
		;;
esac

case $BACKUP_STATE in
	on)
		cat <<EOF
    ${B}Backups${N} — hourly to $NEXTCLOUD_URL, in $NEXTCLOUD_PATH/
      24 hourly slots (db-hHH.sql.gz) and 7 daily ones (db-dN.sql.gz), each
      overwritten as it comes round, so the last day is covered hour by hour and
      the last week day by day. Nothing to prune.

      ${SUDO[*]} systemctl list-timers packripper-backup   # when it next runs
      ${SUDO[*]} journalctl -u packripper-backup -n 20     # what it did
      $DEPLOY_DIR/backup.sh --test        # re-check the credentials

      Each slot is a pg_dump, so it restores into any Postgres — including a
      newer major on a machine you have just rebuilt. Download a slot, then:
        gzip -dc db-hHH.sql.gz | ${DOCKER[*]} exec -i packripper-db \\
          psql -U packripper -d packripper
      The dump is --clean --if-exists, so it drops and recreates as it goes and
      needs no empty database to land in.

EOF
		;;
	notimer)
		cat <<EOF
    ${B}Backups are configured but nothing schedules them.${N} There is no systemd on
    this machine, so add the cron line printed above. The credentials themselves
    can be checked any time with:
      $DEPLOY_DIR/backup.sh --test

EOF
		;;
	broken)
		cat <<EOF
    ${B}Backups are configured but not working${N} — see the message above. The
    timer is installed and keeps trying every hour; fix the NEXTCLOUD_* values in
    $ENV_FILE and confirm with:
      $DEPLOY_DIR/backup.sh --test

EOF
		;;
	*)
		cat <<EOF
    ${B}Nothing is backed up.${N} .data/db.json is every account, collection and
    wallet, and it is on one disk you own. Either re-run this script with
    --nextcloud-url/-user/-pass, or at minimum keep a local copy:
      0 4 * * * tar czf ~/db-\$(date +\\%F).tar.gz -C $DEPLOY_DIR .data

EOF
		;;
esac
if [ "$(id -u)" != 0 ] && [ "${DOCKER[0]}" = sudo ]; then
	warn "log out and back in, then plain \`docker\` works without sudo."
fi
