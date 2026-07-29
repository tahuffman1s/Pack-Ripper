#!/usr/bin/env bash
#
# One-time setup so GitHub Actions can deploy to Azure without a stored secret.
#
# Creates an Entra app registration, a federated credential that trusts *only*
# pushes to this repository's main branch, and a Contributor role assignment
# scoped to the resource group — nothing wider. GitHub then exchanges its own
# short-lived OIDC token for an Azure one at deploy time; there is no client
# secret to leak or rotate.
#
#   azure/github-oidc.sh                 set it up and print what to configure
#   azure/github-oidc.sh remove          delete the app registration again
#
# Needs permission to create app registrations in the tenant (any user can by
# default; some tenants restrict it) and Owner or User Access Administrator on
# the resource group to assign the role. If your account cannot, skip this: run
# azure/deploy.sh by hand when you want to ship, and the deploy workflow stays
# dormant.

set -euo pipefail

REPO=${REPO:-tahuffman1s/Pack-Ripper}
BRANCH=${BRANCH:-main}
RG=${RG:-packripper-rg}
APP_NAME=${APP_NAME:-packripper-github-deploy}

if [ -t 1 ]; then
	B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
else
	B=; DIM=; R=; G=; N=
fi
say() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()  { printf '%s  ok%s %s\n' "$G" "$N" "$*"; }
die() { printf '%sfail%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

AZ=(az --only-show-errors)
command -v az >/dev/null 2>&1 || die "the Azure CLI is not installed"
"${AZ[@]}" account show >/dev/null 2>&1 || die "not signed in — run: az login"

SUB_ID=$("${AZ[@]}" account show --query id -o tsv)
TENANT_ID=$("${AZ[@]}" account show --query tenantId -o tsv)

app_id() { "${AZ[@]}" ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv; }

if [ "${1:-setup}" = remove ]; then
	id=$(app_id)
	[ -n "$id" ] || die "no app registration named $APP_NAME"
	say "deleting app registration $APP_NAME ($id)"
	"${AZ[@]}" ad app delete --id "$id"
	ok "deleted — remember to clear the AZURE_* repository variables"
	exit 0
fi

# ── app registration ───────────────────────────────────────────
CLIENT_ID=$(app_id)
if [ -z "$CLIENT_ID" ]; then
	say "creating app registration $APP_NAME"
	CLIENT_ID=$("${AZ[@]}" ad app create --display-name "$APP_NAME" --query appId -o tsv)
	ok "created ($CLIENT_ID)"
else
	ok "app registration exists ($CLIENT_ID)"
fi

# The service principal is the object role assignments actually point at; the app
# registration alone cannot be granted anything.
if [ -z "$("${AZ[@]}" ad sp list --filter "appId eq '$CLIENT_ID'" --query '[0].id' -o tsv)" ]; then
	say "creating the service principal"
	"${AZ[@]}" ad sp create --id "$CLIENT_ID" >/dev/null
	ok "service principal created"
fi

# ── federated credential ───────────────────────────────────────
# The subject is what pins this to one repo and one branch. A token from any
# other repository, branch or fork does not match and gets nothing. The deploy
# workflow is triggered by workflow_run, which runs in the context of the default
# branch, so the ref subject is the one that matters.
SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"
if [ -z "$("${AZ[@]}" ad app federated-credential list --id "$CLIENT_ID" \
	--query "[?subject=='$SUBJECT'].id" -o tsv)" ]; then
	say "adding the federated credential for $SUBJECT"
	"${AZ[@]}" ad app federated-credential create --id "$CLIENT_ID" --parameters @- >/dev/null <<-JSON
		{
		  "name": "github-${BRANCH}",
		  "issuer": "https://token.actions.githubusercontent.com",
		  "subject": "$SUBJECT",
		  "description": "GitHub Actions deploy from ${REPO} (${BRANCH})",
		  "audiences": ["api://AzureADTokenExchange"]
		}
	JSON
	ok "federated credential added"
else
	ok "federated credential exists"
fi

# ── role assignment ────────────────────────────────────────────
SCOPE="/subscriptions/${SUB_ID}/resourceGroups/${RG}"
"${AZ[@]}" group exists -n "$RG" | grep -q true \
	|| die "resource group $RG does not exist yet — run azure/deploy.sh first"

if [ -z "$("${AZ[@]}" role assignment list --assignee "$CLIENT_ID" --scope "$SCOPE" \
	--query "[?roleDefinitionName=='Contributor'].id" -o tsv)" ]; then
	say "granting Contributor on $RG"
	"${AZ[@]}" role assignment create \
		--assignee "$CLIENT_ID" --role Contributor --scope "$SCOPE" >/dev/null
	ok "role assigned"
else
	ok "role already assigned"
fi

cat <<EOF

${B}Set these as repository variables${N} ${DIM}(Settings -> Secrets and variables -> Actions -> Variables)${N}

  AZURE_CLIENT_ID        $CLIENT_ID
  AZURE_TENANT_ID        $TENANT_ID
  AZURE_SUBSCRIPTION_ID  $SUB_ID

${DIM}Variables, not secrets: none of these is a credential on its own. The trust is
the federated subject above, which only this repository can present.${N}

With the gh CLI:

  gh variable set AZURE_CLIENT_ID --body $CLIENT_ID
  gh variable set AZURE_TENANT_ID --body $TENANT_ID
  gh variable set AZURE_SUBSCRIPTION_ID --body $SUB_ID

EOF
