#!/usr/bin/env bash
#
# PackRipper container runner — app + Cloudflare tunnel.
#
# Uses plain podman/docker commands rather than compose, because podman ships
# without a compose provider and this machine has none: `podman compose` here
# fails with "looking up compose provider failed". docker-compose.yml is still
# in the repo for anyone who does have one. This script needs neither.
#
#   ./run.sh              start the app and open a Cloudflare tunnel
#   ./run.sh local        start the app only, on http://localhost:PORT
#   ./run.sh down         stop and remove both containers
#   ./run.sh logs [app|tunnel]
#   ./run.sh url          print the current public URL
#   ./run.sh build        rebuild the image
#   ./run.sh pull         fetch the image from GHCR instead of building it
#   ./run.sh restart      down, then up again (keeps .data and .cache)
#   ./run.sh status
#   ./run.sh shell        a shell inside the running app container
#   ./run.sh publish      push the current URL to the GitHub Pages redirector
#   ./run.sh watch        keep publishing it as it changes (foreground)
#   ./run.sh unwatch      stop a backgrounded watcher
#
# Flags: --build forces an image rebuild before starting.
#        --watch starts the watcher in the background after starting up.

set -euo pipefail

SELF=$(readlink -f "$0")
cd "$(dirname "$SELF")"

DEFAULT_IMAGE=packripper:latest
APP=packripper
TUNNEL=packripper-tunnel
NETWORK=packripper-net
CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared:latest
WATCH_PID_FILE=.watch.pid
WATCH_LOG=.watch.log

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
PUBLIC_URL="${PUBLIC_URL:-}"
BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-2M}"
CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"

# Set IMAGE (in .env or the environment) to ghcr.io/tahuffman1s/pack-ripper:latest
# to run the published image instead of a locally built one.
IMAGE="${IMAGE:-$DEFAULT_IMAGE}"

# ── the GitHub Pages redirector ────────────────────────────────
# A quick tunnel's hostname changes on every restart, so the link you hand out is
# the Pages one, and it looks up the current hostname in status.json on the pages
# branch. This is the writer for that file. GITHUB_TOKEN needs Contents:
# read+write on this one repo and nothing else.
GITHUB_REPO="${GITHUB_REPO:-tahuffman1s/Pack-Ripper}"
PAGES_BRANCH="${PAGES_BRANCH:-pages}"
PAGES_STATUS_FILE="${PAGES_STATUS_FILE:-status.json}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
PAGES_URL="${PAGES_URL:-https://${GITHUB_REPO%%/*}.github.io/${GITHUB_REPO#*/}/}"
WATCH_INTERVAL="${WATCH_INTERVAL:-30}"

# Used to query a chosen resolver directly — see wait_for_tunnel_dns. Either tool
# will do; neither is guaranteed to be installed.
DIG=$(command -v dig || true)
NSLOOKUP=$(command -v nslookup || true)
JQ=$(command -v jq || true)

exists()  { $ENGINE container inspect "$1" >/dev/null 2>&1; }
running() { [ "$($ENGINE container inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ]; }

# ── build ──────────────────────────────────────────────────────
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
	# A private GHCR package needs a login first:
	#   echo "$GITHUB_TOKEN" | podman login ghcr.io -u <you> --password-stdin
	$ENGINE pull "$IMAGE"
	ok "image pulled"
}

# Missing image: pull it when it comes from a registry, build it when it does not.
ensure_image() {
	have_image && return 0
	if is_remote_image; then pull_image; else build_image; fi
}

ensure_network() {
	$ENGINE network inspect "$NETWORK" >/dev/null 2>&1 || $ENGINE network create "$NETWORK" >/dev/null
}

# ── app ────────────────────────────────────────────────────────
start_app() {
	local publish=("--publish" "127.0.0.1:${PORT}:3000")
	# With a tunnel there is no reason to listen on the host at all; the tunnel
	# reaches the container over the container network. Published on loopback
	# anyway so `./run.sh logs` is not the only way to poke at it.

	mkdir -p .data .cache
	ensure_network

	if exists "$APP"; then $ENGINE rm -f "$APP" >/dev/null; fi

	local env_args=(
		--env "NODE_ENV=production"
		--env "HOST=0.0.0.0"
		--env "PORT=3000"
		--env "BODY_SIZE_LIMIT=${BODY_SIZE_LIMIT}"
	)

	# How the app decides what origin it is serving — see .env.example. A wrong
	# answer here does not break pages, it breaks every POST, which looks like
	# "purchases silently fail" rather than an obvious error.
	if [ -n "$1" ]; then
		env_args+=(--env "ORIGIN=$1")
	else
		env_args+=(--env "PROTOCOL_HEADER=x-forwarded-proto" --env "HOST_HEADER=x-forwarded-host")
	fi

	say "starting $APP"
	$ENGINE run -d \
		--name "$APP" \
		--network "$NETWORK" \
		--restart unless-stopped \
		"${publish[@]}" \
		"${USER_ARGS[@]}" \
		"${env_args[@]}" \
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
			die "the app container stopped while starting"
		fi
		sleep 1
	done
	$ENGINE logs --tail 30 "$APP" >&2 || true
	die "the app did not respond within 180s"
}

# ── tunnel ─────────────────────────────────────────────────────
start_tunnel() {
	if exists "$TUNNEL"; then $ENGINE rm -f "$TUNNEL" >/dev/null; fi

	local args=(
		-d --name "$TUNNEL"
		--network "$NETWORK"
		--restart unless-stopped
		"$CLOUDFLARED_IMAGE"
		tunnel --no-autoupdate
	)

	if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
		say "starting named Cloudflare tunnel"
		args+=(run --token "$CLOUDFLARE_TUNNEL_TOKEN")
	else
		say "starting quick Cloudflare tunnel (no token set)"
		# The quick tunnel resolves the app by container name on our network.
		args+=(--url "http://${APP}:3000")
	fi

	$ENGINE run "${args[@]}" >/dev/null
	ok "tunnel up"
}

# cloudflared prints the generated hostname once, to stderr, a second or two in.
# Take the LAST one in the log, not the first: the container restarts itself
# (--restart unless-stopped) and each restart gets a brand-new hostname while the
# old banner stays in the log. The watcher depends on this being the current one.
quick_tunnel_url() {
	local i url
	for i in $(seq 1 60); do
		url=$($ENGINE logs "$TUNNEL" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
		if [ -n "$url" ]; then printf '%s\n' "$url"; return 0; fi
		if ! running "$TUNNEL"; then return 1; fi
		sleep 1
	done
	return 1
}

# The address the outside world should use, or nothing if we cannot know it — the
# case being a named tunnel whose hostname lives in the Cloudflare dashboard and
# was never written down here.
current_public_url() {
	if [ -n "$PUBLIC_URL" ]; then printf '%s\n' "$PUBLIC_URL"; return 0; fi
	[ -z "$CLOUDFLARE_TUNNEL_TOKEN" ] || return 1
	quick_tunnel_url
}

# Ask one named resolver, so we can check a name without the system resolver ever
# seeing the query. Only A records count; NXDOMAIN and SERVFAIL both mean "no".
resolves_via() {
	local host=$1 ns=$2
	if [ -n "$DIG" ]; then
		[ -n "$("$DIG" +short "$host" @"$ns" 2>/dev/null | grep -E '^[0-9]+\.' || true)" ]
	else
		# nslookup leads with the server it used, whose own Address line would
		# otherwise read as an answer. Drop those two lines first.
		nslookup "$host" "$ns" 2>/dev/null | sed '1,2d' | grep -q '^Address'
	fi
}

# A quick tunnel's hostname does not exist at the moment cloudflared prints it.
# The record appears ten seconds or so later — that is what "it may take some
# time to be reachable" in the banner means. Look it up before then and you get a
# truthful NXDOMAIN, which any resolver may cache for the zone's negative TTL;
# trycloudflare.com's SOA sets that to 1800s. So a single early lookup can leave
# the URL dead for half an hour on the machine that made it, while working
# perfectly for everyone else — an ideal impostor for a broken tunnel.
#
# Hence: poll a public resolver, never the system one, and hold the URL back
# until the record is really published. Flushing afterwards is not a substitute —
# it clears the local stub but not whatever upstream answered.
wait_for_tunnel_dns() {
	local host=${1#https://} i
	if [ -z "$DIG" ] && [ -z "$NSLOOKUP" ]; then
		warn "no dig or nslookup here, so DNS cannot be checked before use."
		warn "Give the URL ~15s before opening it: looking too early can cache a"
		warn "miss for 30 minutes and the URL will seem dead."
		return 0
	fi

	say "waiting for DNS to publish $host"
	for i in $(seq 1 45); do
		if resolves_via "$host" 1.1.1.1; then
			ok "published after ${i}s"
			# Something may already have asked too early — a browser, or a previous
			# run of this script. Costs nothing when it did not.
			resolvectl flush-caches >/dev/null 2>&1 || true
			if ! getent hosts "$host" >/dev/null 2>&1; then
				warn "the record is published, but this machine still gets NXDOMAIN."
				warn "An upstream resolver cached the miss and can hold it for 30"
				warn "minutes. The tunnel is fine and others can reach the URL."
				warn "For one that works here now, take a fresh hostname:"
				warn "  ./run.sh restart"
				warn "Or keep this domain off that resolver for good:"
				warn "  sudo mkdir -p /etc/systemd/resolved.conf.d"
				warn "  printf '[Resolve]\\nDNS=1.1.1.1\\nDomains=~trycloudflare.com\\n' \\"
				warn "    | sudo tee /etc/systemd/resolved.conf.d/trycloudflare.conf"
				warn "  sudo systemctl restart systemd-resolved"
			fi
			return 0
		fi
		sleep 1
	done
	warn "no DNS record after 45s; check ./run.sh logs tunnel, then ./run.sh url"
}

print_url() {
	if [ -n "$PUBLIC_URL" ]; then
		printf '\n  %sPublic:%s  %s\n' "$B" "$N" "$PUBLIC_URL"
	elif [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
		printf '\n  %sPublic:%s  the hostname you configured for this tunnel in Cloudflare\n' "$B" "$N"
		printf '  %s(set PUBLIC_URL in .env to have it printed here — and to pin ORIGIN)%s\n' "$DIM" "$N"
	else
		local url
		if url=$(quick_tunnel_url); then
			# Before printing it, not after: the point is that nobody — including
			# whoever reads this output — looks the name up before it exists.
			wait_for_tunnel_dns "$url"
			printf '\n  %sPublic:%s  %s\n' "$B" "$N" "$url"
			printf '  %sQuick tunnel — this URL disappears when the tunnel stops.%s\n' "$DIM" "$N"
		else
			warn "could not read the quick-tunnel URL; try: ./run.sh logs tunnel"
		fi
	fi
	if [ -n "$GITHUB_TOKEN" ]; then
		printf '  %sShare:%s   %s\n' "$B" "$N" "$PAGES_URL"
		printf '  %s(that one never changes — it forwards to whatever the tunnel is)%s\n' "$DIM" "$N"
	fi
	printf '  %sLocal:%s   http://localhost:%s\n\n' "$B" "$N" "$PORT"
}

# ── publishing the URL ─────────────────────────────────────────
# The link you hand out is the GitHub Pages one, which reads the current tunnel
# hostname out of status.json on the pages branch. Writing that file is one
# Contents-API PUT — no clone, no checkout, no Actions run.

gh_api() { # gh_api METHOD PATH [JSON]  ->  body, then the HTTP code on its own line
	local method=$1 path=$2 data=${3:-}
	local args=(-sS -X "$method" -w '\n%{http_code}'
		-H "Authorization: Bearer $GITHUB_TOKEN"
		-H 'Accept: application/vnd.github+json'
		-H 'X-GitHub-Api-Version: 2022-11-28')
	[ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
	# 000 for "curl never got an answer" (no network, DNS gone), so the caller
	# always has a code to report rather than an empty string.
	curl "${args[@]}" "https://api.github.com/$path" 2>/dev/null || printf '\n000'
}

# One string field out of a JSON document on stdin. jq when it is here; the sed
# fallback is enough for the flat, one-key-per-line shapes we ask about.
json_str() {
	if [ -n "$JQ" ]; then
		"$JQ" -r --arg k "$1" '.[$k] // empty' 2>/dev/null
	else
		sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
	fi
}

# publish_status <url>   — "PackRipper is at <url>"
# publish_status ""      — "PackRipper is offline"
publish_status() {
	local url=${1:-} now kind content body code sha payload b64 prev prev_url prev_up

	if [ -z "$GITHUB_TOKEN" ]; then
		printf '  %s(no GITHUB_TOKEN — the %s redirector was not updated)%s\n' \
			"$DIM" "${PAGES_URL#https://}" "$N"
		return 0
	fi

	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	if [ -n "$url" ]; then
		kind=quick
		[ -n "$CLOUDFLARE_TUNNEL_TOKEN" ] && kind=named
		content=$(printf '{\n  "up": true,\n  "url": "%s",\n  "kind": "%s",\n  "updatedAt": "%s"\n}\n' \
			"$url" "$kind" "$now")
	else
		content=$(printf '{\n  "up": false,\n  "url": null,\n  "kind": null,\n  "updatedAt": "%s"\n}\n' \
			"$now")
	fi

	# The sha of the file we are replacing. Its absence (404) means the pages
	# branch has no status.json yet, which is a create rather than an update.
	body=$(gh_api GET "repos/$GITHUB_REPO/contents/$PAGES_STATUS_FILE?ref=$PAGES_BRANCH") || true
	code=${body##*$'\n'}
	body=${body%$'\n'*}
	sha=
	if [ "$code" = 200 ]; then
		sha=$(printf '%s' "$body" | json_str sha)

		# Every PUT is a commit and every commit is a Pages rebuild, so do not
		# write a file that only differs by its timestamp. (Needs jq to decode the
		# base64 payload; without it we just publish.)
		if [ -n "$JQ" ]; then
			prev=$(printf '%s' "$body" | "$JQ" -r '.content' | base64 -d 2>/dev/null || true)
			prev_url=$(printf '%s' "$prev" | "$JQ" -r '.url // empty' 2>/dev/null || true)
			prev_up=$(printf '%s' "$prev" | "$JQ" -r '.up // false' 2>/dev/null || true)
			# Compare the pair, not the URL alone: "up at X" and "offline, last
			# seen X" are different files that would otherwise look the same.
			[ "$prev_up" = true ] || prev_url=
			if [ "$prev_url" = "$url" ]; then return 0; fi
		fi
	elif [ "$code" != 404 ]; then
		warn "could not read $PAGES_STATUS_FILE (HTTP $code) — is GITHUB_TOKEN valid for $GITHUB_REPO?"
		return 1
	fi

	# printf '%s\n', not '%s': $(...) ate the trailing newline and this ends up as
	# a committed file.
	b64=$(printf '%s\n' "$content" | base64 | tr -d '\n')
	payload=$(printf '{"message":"status: %s","content":"%s","branch":"%s"' \
		"${url:-offline}" "$b64" "$PAGES_BRANCH")
	[ -n "$sha" ] && payload="${payload},\"sha\":\"${sha}\""
	payload="${payload}}"

	body=$(gh_api PUT "repos/$GITHUB_REPO/contents/$PAGES_STATUS_FILE" "$payload") || true
	code=${body##*$'\n'}
	body=${body%$'\n'*}
	case "$code" in
		200 | 201)
			ok "published ${url:-offline} to $GITHUB_REPO ($PAGES_BRANCH)"
			return 0
			;;
		409)
			# Someone else moved the file between our GET and PUT — another machine
			# running this, or the pages workflow. The next pass wins.
			warn "status.json changed underneath us; will retry"
			return 1
			;;
		*)
			warn "publishing failed (HTTP $code): $(printf '%s' "$body" | json_str message)"
			return 1
			;;
	esac
}

# Work out the URL first, and keep quiet rather than claiming "offline" when the
# app is up but its hostname is only known to Cloudflare.
publish_current() {
	local url
	if url=$(current_public_url); then
		publish_status "$url"
	elif [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
		warn "this named tunnel's hostname is not known here, so the redirector at"
		warn "$PAGES_URL cannot be pointed at it. Set PUBLIC_URL in .env."
	else
		publish_status ""
	fi
}

# ── watcher ────────────────────────────────────────────────────
# Handles the cases nothing else does: cloudflared restarting on its own (a new
# random hostname, and nobody ran run.sh), or the app falling over. Publishes
# only on change, so an idle watcher costs one API read per interval and no
# commits.
watch_running() {
	[ -f "$WATCH_PID_FILE" ] && kill -0 "$(cat "$WATCH_PID_FILE" 2>/dev/null)" 2>/dev/null
}

start_watcher() {
	if watch_running; then ok "watcher already running (pid $(cat "$WATCH_PID_FILE"))"; return 0; fi
	[ -n "$GITHUB_TOKEN" ] || { warn "no GITHUB_TOKEN — not starting the watcher"; return 0; }
	nohup "$SELF" watch >>"$WATCH_LOG" 2>&1 &
	printf '%s\n' "$!" >"$WATCH_PID_FILE"
	ok "watcher started (pid $!, logging to $WATCH_LOG)"
}

stop_watcher() {
	if watch_running; then
		kill "$(cat "$WATCH_PID_FILE")" 2>/dev/null || true
		ok "watcher stopped"
	fi
	rm -f "$WATCH_PID_FILE"
}

cmd_watch() {
	local last=__unknown__ desired
	[ -n "$GITHUB_TOKEN" ] || die "watch needs GITHUB_TOKEN in .env (Contents: read and write on $GITHUB_REPO)"
	if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ] && [ -z "$PUBLIC_URL" ]; then
		die "a named tunnel with no PUBLIC_URL leaves the watcher nothing to publish"
	fi

	say "watching every ${WATCH_INTERVAL}s; publishing changes to $GITHUB_REPO ($PAGES_BRANCH)"
	while :; do
		desired=
		if running "$APP" && running "$TUNNEL" && app_healthy; then
			desired=$(current_public_url || true)
		fi

		if [ "$desired" != "$last" ]; then
			# A hostname cloudflared has just minted does not resolve yet, and
			# publishing it early is worse than publishing it a few seconds late: the
			# first visitor to look it up gets a truthful NXDOMAIN, which their
			# resolver is entitled to cache for trycloudflare.com's 1800s negative
			# TTL. Hold it back until the record is really there.
			if [ -n "$desired" ] && [ "$desired" != "$PUBLIC_URL" ]; then
				wait_for_tunnel_dns "$desired"
			fi
			if publish_status "$desired"; then last=$desired; fi
		fi
		sleep "$WATCH_INTERVAL"
	done
}

# ── commands ───────────────────────────────────────────────────
cmd_up() {
	ensure_image
	start_app "$PUBLIC_URL"
	wait_for_app
	start_tunnel
	print_url
	publish_current
	[ -n "$WATCH" ] && start_watcher
	return 0
}

cmd_local() {
	ensure_image
	# Direct http on localhost: the origin is known exactly, so pin it. Without
	# this the app assumes https and every POST fails the CSRF check.
	start_app "http://localhost:${PORT}"
	wait_for_app
	printf '\n  %sLocal:%s   http://localhost:%s\n  %s(no tunnel)%s\n\n' "$B" "$N" "$PORT" "$DIM" "$N"
}

cmd_down() {
	local c
	# Before the containers, so it cannot publish "up" a second after we have
	# published "offline".
	stop_watcher
	for c in "$TUNNEL" "$APP"; do
		if exists "$c"; then $ENGINE rm -f "$c" >/dev/null && ok "removed $c"; fi
	done
	$ENGINE network rm "$NETWORK" >/dev/null 2>&1 || true
	# So the redirector says "offline, watching for it to come back" rather than
	# sending visitors to a hostname that has stopped existing.
	publish_status ""
}

cmd_status() {
	$ENGINE ps --filter "name=${APP}" --filter "name=${TUNNEL}" \
		--format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

cmd_logs() {
	case "${1:-app}" in
		app) $ENGINE logs -f "$APP" ;;
		tunnel) $ENGINE logs -f "$TUNNEL" ;;
		*) die "logs takes 'app' or 'tunnel'" ;;
	esac
}

usage() { sed -n '/^# PackRipper container runner/,/^set -euo/p' "$0" | sed '/^set -euo/d; s/^# \?//'; }

# --build anywhere in the arguments forces a rebuild first; --watch leaves the
# URL watcher running afterwards.
ARGS=()
FORCE_BUILD=
WATCH=
for a in "$@"; do
	case "$a" in
		--build) FORCE_BUILD=1 ;;
		--watch) WATCH=1 ;;
		*) ARGS+=("$a") ;;
	esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
[ -n "$FORCE_BUILD" ] && build_image

case "${1:-up}" in
	up)      cmd_up ;;
	local)   cmd_local ;;
	down|stop) cmd_down ;;
	restart) cmd_down; cmd_up ;;
	build)   [ -n "$FORCE_BUILD" ] || build_image ;;
	pull)    pull_image ;;
	logs)    cmd_logs "${2:-app}" ;;
	url)     print_url ;;
	status)  cmd_status ;;
	shell)   $ENGINE exec -it "$APP" sh ;;
	publish) publish_current ;;
	watch)   cmd_watch ;;
	unwatch) stop_watcher ;;
	-h|--help|help) usage ;;
	*)       die "unknown command '$1' — try ./run.sh --help" ;;
esac
