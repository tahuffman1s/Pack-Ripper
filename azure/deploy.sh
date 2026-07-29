#!/usr/bin/env bash
#
# Deploy PackRipper to Azure Container Apps.
#
# Pulls the image GitHub Actions publishes to GHCR and runs it behind Azure's
# own HTTPS ingress, so there is no tunnel and no changing hostname:
#
#   https://packripper.<something>.<region>.azurecontainerapps.io
#
# Idempotent — run it again to deploy a new image or change a setting. Every run
# either creates what is missing or updates what is there.
#
#   azure/deploy.sh              create or update everything, print the URL
#   azure/deploy.sh url          print the app's URL
#   azure/deploy.sh logs         follow the container log
#   azure/deploy.sh status       revision, replica and provisioning state
#   azure/deploy.sh restart      restart the current revision
#   azure/deploy.sh destroy      delete the resource group (needs CONFIRM=1)
#
# Everything is overridable from the environment:
#
#   IMAGE=ghcr.io/tahuffman1s/pack-ripper:sha-abc1234 azure/deploy.sh
#   LOCATION=westeurope RG=my-rg azure/deploy.sh
#
# Costs, roughly: one always-on replica at 0.5 vCPU / 1 GiB is about $10-15 a
# month against your credits, plus pennies for the file share. Container Apps
# bills per second, so `destroy` really does stop the meter.

set -euo pipefail

RG=${RG:-packripper-rg}
LOCATION=${LOCATION:-eastus}
ENVIRONMENT=${ENVIRONMENT:-packripper-env}
APP=${APP:-packripper}
IMAGE=${IMAGE:-ghcr.io/tahuffman1s/pack-ripper:latest}
SHARE=${SHARE:-data}
CPU=${CPU:-0.5}
MEMORY=${MEMORY:-1.0Gi}
BODY_SIZE_LIMIT=${BODY_SIZE_LIMIT:-2M}

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

AZ=(az --only-show-errors)

# ── preflight ──────────────────────────────────────────────────
preflight() {
	command -v az >/dev/null 2>&1 || die "the Azure CLI is not installed.
  Fedora:  sudo dnf install azure-cli
  or:      https://aka.ms/InstallAzureCLIDeb / brew install azure-cli
  or skip the install entirely and run this in Cloud Shell: https://shell.azure.com"

	"${AZ[@]}" account show >/dev/null 2>&1 || die "not signed in — run: az login"

	if [ -n "${SUBSCRIPTION:-}" ]; then
		"${AZ[@]}" account set --subscription "$SUBSCRIPTION"
	fi
	local name id
	name=$("${AZ[@]}" account show --query name -o tsv)
	id=$("${AZ[@]}" account show --query id -o tsv)
	say "subscription: $name ${DIM}($id)${N}"

	# The containerapp commands live in an extension on older CLI builds and are
	# built in on newer ones. Adding it when it is already present is a no-op.
	"${AZ[@]}" extension add --name containerapp --upgrade >/dev/null 2>&1 || true

	# A fresh subscription has these unregistered, and every later command then
	# fails with MissingSubscriptionRegistration. Registering is idempotent and
	# takes a moment the first time.
	local ns
	for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Storage; do
		if [ "$("${AZ[@]}" provider show -n "$ns" --query registrationState -o tsv 2>/dev/null)" != Registered ]; then
			say "registering $ns (first time only, this can take a minute)"
			"${AZ[@]}" provider register -n "$ns" --wait
		fi
	done

	# Storage account names are globally unique, 3-24 chars, lowercase letters and
	# digits only. Derived from the subscription id so re-running this picks the
	# same account instead of leaving a trail of new ones.
	if [ -z "${STORAGE:-}" ]; then
		STORAGE=packripper$(printf '%s' "$id" | tr -d - | cut -c1-8)
	fi
}

exists_rg()      { "${AZ[@]}" group exists -n "$RG" | grep -q true; }
exists_storage() { "${AZ[@]}" storage account show -n "$STORAGE" -g "$RG" >/dev/null 2>&1; }
exists_env()     { "${AZ[@]}" containerapp env show -n "$ENVIRONMENT" -g "$RG" >/dev/null 2>&1; }
exists_app()     { "${AZ[@]}" containerapp show -n "$APP" -g "$RG" >/dev/null 2>&1; }

# ── infrastructure ─────────────────────────────────────────────
ensure_rg() {
	if exists_rg; then ok "resource group $RG"; return; fi
	say "creating resource group $RG in $LOCATION"
	"${AZ[@]}" group create -n "$RG" -l "$LOCATION" >/dev/null
	ok "resource group created"
}

# Only .data is on durable storage. .cache is ~100 MB of regenerated Scryfall,
# MTGJSON and TCGplayer data with its own TTLs, and it is thousands of small
# reads — exactly what SMB is worst at. It lives on the replica's local disk
# instead and refills itself after a deploy, which costs a slow first minute and
# saves every request after it.
ensure_storage() {
	if ! exists_storage; then
		say "creating storage account $STORAGE"
		"${AZ[@]}" storage account create \
			-n "$STORAGE" -g "$RG" -l "$LOCATION" \
			--sku Standard_LRS --kind StorageV2 \
			--allow-blob-public-access false \
			--min-tls-version TLS1_2 >/dev/null
		ok "storage account created"
	else
		ok "storage account $STORAGE"
	fi

	local key
	key=$("${AZ[@]}" storage account keys list -n "$STORAGE" -g "$RG" --query '[0].value' -o tsv)

	if ! "${AZ[@]}" storage share exists --name "$SHARE" \
		--account-name "$STORAGE" --account-key "$key" --query exists | grep -q true; then
		say "creating file share $SHARE"
		# 5 GiB. The whole database is one JSON file measured in KB; the quota is
		# only an upper bound and costs nothing until it is used.
		"${AZ[@]}" storage share create --name "$SHARE" --quota 5 \
			--account-name "$STORAGE" --account-key "$key" >/dev/null
		ok "file share created"
	else
		ok "file share $SHARE"
	fi

	STORAGE_KEY=$key
}

ensure_env() {
	if exists_env; then ok "environment $ENVIRONMENT"; return; fi
	say "creating Container Apps environment $ENVIRONMENT"
	# --logs-destination none skips the Log Analytics workspace this would
	# otherwise create and bill for. `deploy.sh logs` streams from the container
	# directly and does not need it; only historical log *queries* would.
	"${AZ[@]}" containerapp env create \
		-n "$ENVIRONMENT" -g "$RG" -l "$LOCATION" \
		--logs-destination none >/dev/null
	ok "environment created"
}

# Registers the share with the environment under the name the app's volume
# refers to. Safe to repeat; it is a PUT.
ensure_env_storage() {
	say "linking the file share to the environment"
	"${AZ[@]}" containerapp env storage set \
		-n "$ENVIRONMENT" -g "$RG" \
		--storage-name "$SHARE" \
		--azure-file-account-name "$STORAGE" \
		--azure-file-account-key "$STORAGE_KEY" \
		--azure-file-share-name "$SHARE" \
		--access-mode ReadWrite >/dev/null
	ok "share linked as '$SHARE'"
}

# ── the app ────────────────────────────────────────────────────
# The hostname is known before the app exists: it is <app>.<env default domain>.
# That matters because ORIGIN has to be baked into the container's environment,
# and SvelteKit rejects every POST whose Origin header disagrees with it — a
# wrong value here does not break pages, it breaks login and buying while
# everything keeps looking fine.
app_fqdn() {
	local domain
	domain=$("${AZ[@]}" containerapp env show -n "$ENVIRONMENT" -g "$RG" \
		--query properties.defaultDomain -o tsv)
	printf '%s.%s\n' "$APP" "$domain"
}

write_spec() {
	local fqdn=$1 file=$2 env_id
	env_id=$("${AZ[@]}" containerapp env show -n "$ENVIRONMENT" -g "$RG" --query id -o tsv)

	cat >"$file" <<-YAML
		location: $LOCATION
		type: Microsoft.App/containerApps
		properties:
		  environmentId: $env_id
		  configuration:
		    activeRevisionsMode: Single
		    ingress:
		      external: true
		      targetPort: 3000
		      transport: auto
		      # Azure terminates TLS and will not serve the app over plain http.
		      allowInsecure: false
		      traffic:
		        - latestRevision: true
		          weight: 100
		  template:
		    containers:
		      - name: packripper
		        image: $IMAGE
		        resources:
		          cpu: $CPU
		          memory: $MEMORY
		        env:
		          - name: NODE_ENV
		            value: production
		          - name: HOST
		            value: 0.0.0.0
		          - name: PORT
		            value: "3000"
		          - name: ORIGIN
		            value: https://$fqdn
		          - name: BODY_SIZE_LIMIT
		            value: $BODY_SIZE_LIMIT
		        volumeMounts:
		          - volumeName: data
		            mountPath: /app/.data
		        probes:
		          # A cold .cache means the first request fetches the Scryfall set
		          # list and probes ~55 sets for sealed prices before anything is
		          # served, and the probe itself is that first request. Hence a
		          # startup budget of five minutes; without it the platform would
		          # decide the container is broken and restart it in a loop.
		          - type: Startup
		            httpGet:
		              path: /api/health
		              port: 3000
		            periodSeconds: 10
		            timeoutSeconds: 30
		            failureThreshold: 30
		          - type: Liveness
		            httpGet:
		              path: /api/health
		              port: 3000
		            periodSeconds: 30
		            timeoutSeconds: 10
		            failureThreshold: 5
		    scale:
		      # Exactly one. db.js keeps the whole database in memory and flushes it
		      # to one file; a second replica would not see the first one's writes
		      # and would overwrite them. Scaling this app means a real database
		      # first.
		      minReplicas: 1
		      maxReplicas: 1
		    volumes:
		      - name: data
		        storageType: AzureFile
		        storageName: $SHARE
	YAML
}

deploy_app() {
	local fqdn spec
	fqdn=$(app_fqdn)
	spec=$(mktemp -t packripper-app-XXXXXX.yaml)
	trap 'rm -f "$spec"' RETURN
	write_spec "$fqdn" "$spec"

	if exists_app; then
		say "updating $APP with $IMAGE"
		"${AZ[@]}" containerapp update -n "$APP" -g "$RG" --yaml "$spec" >/dev/null
		ok "new revision deployed"
	else
		say "creating $APP from $IMAGE"
		# The GHCR package is public, so no registry credentials are needed. For a
		# private one, add:
		#   az containerapp registry set -n $APP -g $RG --server ghcr.io \
		#     --username <you> --password <a token with read:packages>
		"${AZ[@]}" containerapp create -n "$APP" -g "$RG" --yaml "$spec" >/dev/null
		ok "app created"
	fi
}

# ── waiting ────────────────────────────────────────────────────
# Provisioning returns before the container is serving. A cold cache means the
# first response can be minutes away, so poll the URL rather than trusting the
# ARM state.
wait_for_app() {
	local url=$1 i code
	say "waiting for the app to answer (a cold cache makes the first boot slow)"
	for i in $(seq 1 60); do
		code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$url/api/health" || true)
		if [ "$code" = 200 ]; then
			ok "answering after $((i * 5))s"
			return 0
		fi
		sleep 5
	done
	warn "no 200 from $url/api/health after 5 minutes"
	warn "check the log: azure/deploy.sh logs"
	return 1
}

# ── commands ───────────────────────────────────────────────────
cmd_deploy() {
	preflight
	ensure_rg
	ensure_storage
	ensure_env
	ensure_env_storage
	deploy_app

	local url="https://$(app_fqdn)"
	wait_for_app "$url" || true
	printf '\n  %sPublic:%s  %s\n' "$B" "$N" "$url"
	printf '  %sData:%s    %s/%s (Azure Files) — survives every deploy\n' "$B" "$N" "$STORAGE" "$SHARE"
	printf '  %sImage:%s   %s\n\n' "$B" "$N" "$IMAGE"
}

cmd_url() {
	preflight >/dev/null
	printf 'https://%s\n' "$(app_fqdn)"
}

cmd_logs() {
	preflight >/dev/null
	"${AZ[@]}" containerapp logs show -n "$APP" -g "$RG" --follow --tail 50
}

cmd_status() {
	preflight >/dev/null
	"${AZ[@]}" containerapp show -n "$APP" -g "$RG" \
		--query '{fqdn:properties.configuration.ingress.fqdn, state:properties.provisioningState, revision:properties.latestReadyRevisionName, image:properties.template.containers[0].image}' \
		-o yaml
	"${AZ[@]}" containerapp replica list -n "$APP" -g "$RG" \
		--query '[].{replica:name, created:properties.createdTime, state:properties.runningState}' -o table 2>/dev/null || true
}

cmd_restart() {
	preflight >/dev/null
	local rev
	rev=$("${AZ[@]}" containerapp show -n "$APP" -g "$RG" \
		--query properties.latestReadyRevisionName -o tsv)
	say "restarting $rev"
	"${AZ[@]}" containerapp revision restart -n "$APP" -g "$RG" --revision "$rev" >/dev/null
	ok "restarted"
}

cmd_destroy() {
	preflight
	[ "${CONFIRM:-}" = 1 ] || die "this deletes resource group $RG and everything in it,
  including the file share holding every account and its collection.
  Re-run with: CONFIRM=1 azure/deploy.sh destroy"
	say "deleting resource group $RG"
	"${AZ[@]}" group delete -n "$RG" --yes --no-wait
	ok "deletion started (it runs in the background)"
}

usage() { sed -n '/^# Deploy PackRipper/,/^set -euo/p' "$0" | sed '/^set -euo/d; s/^# \?//'; }

case "${1:-deploy}" in
	deploy | up) cmd_deploy ;;
	url)     cmd_url ;;
	logs)    cmd_logs ;;
	status)  cmd_status ;;
	restart) cmd_restart ;;
	destroy | down) cmd_destroy ;;
	-h | --help | help) usage ;;
	*) die "unknown command '$1' — try azure/deploy.sh --help" ;;
esac
