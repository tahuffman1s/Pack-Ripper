#!/bin/sh
#
# PackRipper container entrypoint — the app, and optionally a Cloudflare Tunnel
# beside it.
#
# The tunnel is off unless TUNNEL_TOKEN (or TUNNEL_TOKEN_FILE) is set, and with
# it off this script does exactly what the old CMD did: exec node, which becomes
# PID 1 and receives `docker stop` itself. Nothing about the Azure or Oracle
# deployments changes.
#
# With it on, cloudflared dials OUT to Cloudflare and traffic returns down that
# connection, so the container needs no published port, no inbound firewall
# rule, and no certificate. It reaches the app over the container's own
# loopback — which is why the public hostname in the Cloudflare dashboard must
# point at http://localhost:3000 and not at a service name.
#
# See ../README.md § Hosting it on a Raspberry Pi.

set -eu

# A one-off command (`docker run … admin list`) is not the server, and must not
# drag a second tunnel connection up beside it. Only the default CMD, or an
# explicit `node …`, gets the supervisor treatment.
case "${1:-}" in
	node) ;;
	*) exec "$@" ;;
esac

if [ -z "${TUNNEL_TOKEN:-}" ] && [ -z "${TUNNEL_TOKEN_FILE:-}" ]; then
	exec "$@"
fi

app=
tunnel=
napper=

# A child that has exited but has not been reaped is a zombie and keeps its
# /proc entry, so the state field is what to read, not the directory. An empty
# PID reads as not alive, which is what the shutdown path wants before the
# children exist.
alive() {
	state=$(awk '/^State:/ { print $2 }' "/proc/${1}/status" 2>/dev/null)
	[ -n "$state" ] && [ "$state" != Z ]
}

# Compose sends SIGTERM and waits ten seconds before SIGKILL. sh is PID 1 here,
# so nothing reaches the children unless this forwards it — and the trap is
# installed before they start, so there is no window where a stop is ignored.
#
# SIGTERM first, because that is what makes db.js flush the database, then
# SIGKILL if that did not do it. The app answers a SIGTERM in about 100ms and
# bounds itself at SHUTDOWN_GRACE_MS either way, so the escalation should never
# be reached — but a polite `wait` with no bound at all would hang PID 1 forever
# on anything that did get stuck, leaving a container that is up, healthy-looking
# and serving nobody. That is the failure this whole file exists to prevent.
reap() {
	kill $app $tunnel $napper 2>/dev/null || true

	waited=0
	while [ "$waited" -lt 10 ] && { alive "$app" || alive "$tunnel"; }; do
		sleep 1
		waited=$((waited + 1))
	done
	kill -KILL $app $tunnel 2>/dev/null || true

	wait || true
}
trap 'trap - TERM INT; reap; exit 0' TERM INT

# cloudflared reads TUNNEL_TOKEN / TUNNEL_TOKEN_FILE by itself, so the token
# never reaches this process's argv, where `ps` inside the container would
# print it.
#
# --no-autoupdate: the update path rewrites the binary on disk and restarts
#   itself. In a container that is pointless — the change is lost on the next
#   `up` — and it is a restart nobody asked for. Bump the pinned version in the
#   Dockerfile instead.
# --metrics on loopback: a fixed port so docker-healthcheck.sh can find /ready,
#   and 127.0.0.1 because the flag's own default is 0.0.0.0 on a random one.
echo "entrypoint: starting cloudflared" >&2
cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:2000 run &
tunnel=$!

"$@" &
app=$!

# Whichever half exits takes the other one with it, so the container exits too
# and `restart: unless-stopped` gets its chance. Without this a dead tunnel
# would leave a container that looks fine, passes a port check, and serves
# nobody.
#
# Polled, rather than the `wait -n` this obviously wants to be. Busybox's
# `wait -n` only reports children that exit AFTER it is called, so a tunnel
# rejected for a bad token — much the commonest way to get this wrong, and it
# happens inside a second — is already gone by then and the script blocks on it
# forever. That is precisely the failure this loop exists to catch.
while alive "$app" && alive "$tunnel"; do
	# Backgrounded and waited on rather than run in the foreground: busybox
	# defers a trap until the running foreground command finishes, which would
	# make every stop sit out the rest of this interval before shutting down.
	# `wait` is interruptible, so the trap fires immediately.
	sleep 5 &
	napper=$!
	wait "$napper" || true
done
napper=

# `wait` on an already-exited child still yields its status.
status=0
if alive "$app"; then
	wait "$tunnel" || status=$?
	echo "entrypoint: cloudflared exited ($status) — stopping the app too" >&2
else
	wait "$app" || status=$?
	echo "entrypoint: the app exited ($status) — stopping cloudflared too" >&2
fi

reap
exit "$status"
