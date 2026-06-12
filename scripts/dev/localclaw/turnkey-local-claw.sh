#!/usr/bin/env bash
# turnkey-local-claw.sh — one-command install of the trusted host-native claw:
#   1. guard VM (untrusted-content service, fail-closed)
#   2. host OpenClaw build from this checkout
#   3. gateway config (guard plugin + optional model provider)
#   4. managed launchd gateway install
#   5. smoke checks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"

log() { printf '[turnkey-local-claw] %s\n' "$*"; }
die() { printf '[turnkey-local-claw] error: %s\n' "$*" >&2; exit 1; }

NAME="localclaw"
WORKSPACE=""
GUARD_PORT="18787"
AGENT_NAME="Local Claw"
MODEL_BASE_URL=""
MODEL_ID=""
MODEL_API_KEY_ENV="LOCALCLAW_MODEL_API_KEY"
ASSUME_YES="${LOCALCLAW_ASSUME_YES:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --guard-port) GUARD_PORT="$2"; shift 2 ;;
    --agent-name) AGENT_NAME="$2"; shift 2 ;;
    --model-base-url) MODEL_BASE_URL="$2"; shift 2 ;;
    --model-id) MODEL_ID="$2"; shift 2 ;;
    --model-api-key-env) MODEL_API_KEY_ENV="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

WORKSPACE="${WORKSPACE:-$HOME/claws/$NAME}"
RUNTIME_DIR="$WORKSPACE_ROOT/claw-runtime/$NAME"

# --- preflight --------------------------------------------------------------
command -v limactl >/dev/null || die "limactl required"
command -v node >/dev/null || die "node required"
command -v corepack >/dev/null || die "corepack required"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "Node 22+ required"
[[ -f "$REPO_ROOT/package.json" ]] || die "run from the openclaw-exocortex checkout"

log "runtime: $NAME"
log "workspace: $WORKSPACE"
log "guard: http://127.0.0.1:$GUARD_PORT (VM ${NAME}-guard)"
if [[ -n "$MODEL_BASE_URL" ]]; then
  log "model: $MODEL_ID via $MODEL_BASE_URL (key env: $MODEL_API_KEY_ENV)"
else
  log "model: none configured here; run 'openclaw onboard' afterwards for a provider"
fi
if [[ "$ASSUME_YES" != "1" ]]; then
  read -r -p "[turnkey-local-claw] proceed? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted"
fi

mkdir -p "$WORKSPACE" "$RUNTIME_DIR/metadata"

# --- 1. guard VM ------------------------------------------------------------
bash "$SCRIPT_DIR/create-guard-vm.sh" --name "$NAME" --guard-port "$GUARD_PORT"

# --- 2. host build ----------------------------------------------------------
log "building OpenClaw from checkout"
(cd "$REPO_ROOT" && corepack pnpm install && corepack pnpm build)

# --- 3. credentials + config ------------------------------------------------
if [[ -n "$MODEL_BASE_URL" && -n "${LOCALCLAW_MODEL_API_KEY:-}" ]]; then
  # The launchd-managed gateway only carries a fixed OPENCLAW_* service env,
  # so env SecretRefs must come from the global runtime dotenv the gateway
  # loads at startup (~/.openclaw/.env). Replace-or-append keeps other keys.
  ENV_FILE="$HOME/.openclaw/.env"
  mkdir -p "$HOME/.openclaw"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  grep -v "^${MODEL_API_KEY_ENV}=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  printf '%s=%s\n' "$MODEL_API_KEY_ENV" "$LOCALCLAW_MODEL_API_KEY" >> "$ENV_FILE.tmp"
  chmod 600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  log "wrote model credential to ~/.openclaw/.env (0600); value not printed"
fi

LOCALCLAW_GUARD_BASE_URL="http://127.0.0.1:$GUARD_PORT" \
LOCALCLAW_WORKSPACE="$WORKSPACE" \
LOCALCLAW_AGENT_NAME="$AGENT_NAME" \
LOCALCLAW_MODEL_BASE_URL="$MODEL_BASE_URL" \
LOCALCLAW_MODEL_ID="$MODEL_ID" \
LOCALCLAW_MODEL_API_KEY_ENV="$MODEL_API_KEY_ENV" \
  node "$SCRIPT_DIR/configure-local-claw.mjs"

# --- 4. managed gateway install ----------------------------------------------
log "installing managed gateway service (launchd)"
(cd "$REPO_ROOT" && corepack pnpm openclaw gateway install --force)
(cd "$REPO_ROOT" && corepack pnpm openclaw gateway status --deep) || true

# --- 5. metadata + smoke ------------------------------------------------------
cat > "$RUNTIME_DIR/metadata/localclaw.json" <<META
{
  "kind": "local",
  "name": "$NAME",
  "guardPort": $GUARD_PORT,
  "workspace": "$WORKSPACE",
  "gatewayPort": 18789
}
META

curl -fsS "http://127.0.0.1:$GUARD_PORT/health" >/dev/null || die "guard health failed"
log "done. Next: 'openclaw onboard' for channels/providers as needed,"
log "then smoke per scripts/dev/localclaw/README.md (fail-closed test included)."
