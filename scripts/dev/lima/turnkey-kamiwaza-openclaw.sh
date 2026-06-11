#!/usr/bin/env bash
set -euo pipefail

# Turnkey installer for the Kamiwaza-integrated OpenClaw Lima VM pair.
#
# One entry point that:
#   1. checks host prerequisites,
#   2. validates Kamiwaza API access, prompting for an API key or a
#      username/password (used to mint a PAT) when nothing valid is found,
#   3. checks for a DEPLOYED Kamiwaza model, advising the user to deploy one
#      through the Kamiwaza UI first (with an explicit bypass),
#   4. derives the model endpoint OpenClaw should use,
#   5. hands off to bootstrap-kamiwaza-mode.sh which deploys the Kamiwaza
#      tool extensions (serper web search, untrusted-content guard) and
#      bootstraps the trusted/untrusted VM pair.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# claw-runtime-env.sh is sourced after argument parsing: it derives runtime
# paths, ports, and LIMA_HOME from OPENCLAW_RUNTIME_NAME, and sourcing it
# before --runtime-name/--port-offset are known would lock in the defaults.

log() {
  printf '[openclaw turnkey] %s\n' "$*"
}

warn() {
  printf '[openclaw turnkey] warning: %s\n' "$*" >&2
}

die() {
  printf '[openclaw turnkey] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/dev/lima/turnkey-kamiwaza-openclaw.sh [options] [-- bootstrap args...]

Turnkey install of the Kamiwaza-integrated OpenClaw trusted/untrusted VM pair.
Prompts only for what it cannot discover: Kamiwaza credentials when no valid
API key is available, and a continue/abort decision when no model is deployed.

Environment:
  KAMIWAZA_API_URL                Kamiwaza API base, default https://localhost/api.
  KAMIWAZA_API_KEY                Existing Kamiwaza API key/PAT to validate and use.
  KAMIWAZA_USERNAME               Username for PAT generation, default admin.
  KAMIWAZA_PASSWORD               Password for PAT generation (else prompted or
                                  resolved through OPENCLAW_KAMIWAZA_LOGIN_SCRIPT).
  OPENCLAW_KAMIWAZA_PAT_NAME      Name for the generated PAT, default openclaw-<runtime>.
  OPENCLAW_KAMIWAZA_PAT_TTL_SECONDS  Generated PAT TTL, default 2592000 (30 days).
  OPENCLAW_KAMIWAZA_MODEL_NAME    Preferred deployed model name (m_name); default first DEPLOYED.
  OPENCLAW_KAMIWAZA_ALLOW_NO_MODEL  Set 1 to proceed without a deployed model.
  OPENCLAW_KAMIWAZA_GUEST_API_HOST  Hostname guests use for the Kamiwaza API,
                                  default host.lima.internal.
  OPENCLAW_RUNTIME_NAME           Runtime name, default openclaw.
  OPENCLAW_RUNTIME_PORT_OFFSET    Numeric port offset for additional VM pairs.
  OPENCLAW_TURNKEY_ASSUME_YES     Set 1 to accept all confirmation prompts.

Options:
  --runtime-name NAME             Set OPENCLAW_RUNTIME_NAME.
  --port-offset N                 Set OPENCLAW_RUNTIME_PORT_OFFSET.
  --model NAME                    Set OPENCLAW_KAMIWAZA_MODEL_NAME.
  --yes                           Accept confirmation prompts (no-model bypass).
  -h, --help                      Show this help.

Arguments after -- are passed to bootstrap-kamiwaza-mode.sh unchanged.

Examples:
  scripts/dev/lima/turnkey-kamiwaza-openclaw.sh
  scripts/dev/lima/turnkey-kamiwaza-openclaw.sh --runtime-name kz1 --port-offset 7000
USAGE
}

BOOTSTRAP_PASSTHROUGH=()
ASSUME_YES="${OPENCLAW_TURNKEY_ASSUME_YES:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-name)
      [[ $# -ge 2 ]] || die "--runtime-name requires a value"
      export OPENCLAW_RUNTIME_NAME="$2"
      shift 2
      ;;
    --port-offset)
      [[ $# -ge 2 ]] || die "--port-offset requires a value"
      export OPENCLAW_RUNTIME_PORT_OFFSET="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || die "--model requires a value"
      export OPENCLAW_KAMIWAZA_MODEL_NAME="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --)
      shift
      BOOTSTRAP_PASSTHROUGH=("$@")
      break
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (use -- to pass bootstrap args)"
      ;;
  esac
done

source "$SCRIPT_DIR/claw-runtime-env.sh"

# This script handles raw Kamiwaza credentials; never trace it.
case "$-" in
  *x*)
    set +x
    printf '[openclaw turnkey] xtrace disabled to protect credentials\n' >&2
    ;;
esac

KAMIWAZA_API_URL="${KAMIWAZA_API_URL:-https://localhost/api}"
KAMIWAZA_API_URL="${KAMIWAZA_API_URL%/}"
GUEST_API_HOST="${OPENCLAW_KAMIWAZA_GUEST_API_HOST:-host.lima.internal}"
CURL_BIN="${OPENCLAW_TURNKEY_CURL:-curl}"
BOOTSTRAP_SCRIPT="${OPENCLAW_TURNKEY_BOOTSTRAP_SCRIPT:-$SCRIPT_DIR/bootstrap-kamiwaza-mode.sh}"

is_interactive() {
  [[ -t 0 && "$ASSUME_YES" != "1" ]]
}

confirm_or_die() {
  local prompt="$1"
  local bypass_hint="$2"
  if [[ "$ASSUME_YES" == "1" ]]; then
    log "$prompt -> continuing (assume-yes)"
    return
  fi
  if [[ ! -t 0 ]]; then
    die "$prompt. Re-run with --yes or $bypass_hint to continue anyway."
  fi
  local answer=""
  read -r -p "[openclaw turnkey] $prompt — continue anyway? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted by user"
}

kamiwaza_api() {
  local method="$1"
  local path="$2"
  local token="${3:-}"
  local out="$4"
  shift 4
  local args=(-sk -m 20 -X "$method" "$KAMIWAZA_API_URL$path" -o "$out" -w '%{http_code}')
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  "$CURL_BIN" "${args[@]}" "$@" 2>/dev/null || printf '000'
}

json_field() {
  local file="$1"
  local expr="$2"
  node -e '
    const fs = require("fs");
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch {
      process.exit(1);
    }
    const path = process.argv[2].split(".").filter(Boolean);
    let value = parsed;
    for (const key of path) {
      if (value === null || typeof value !== "object") process.exit(1);
      value = value[key];
    }
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  ' "$file" "$expr"
}

check_host_prerequisites() {
  if [[ "${OPENCLAW_TURNKEY_SKIP_HOST_CHECK:-0}" == "1" ]]; then
    log "skipping host prerequisite checks"
    return
  fi
  log "checking host prerequisites"
  local missing=()
  local cmd
  for cmd in limactl kubectl node jq git rsync; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    missing+=("docker-or-podman")
  fi
  [[ "${#missing[@]}" -eq 0 ]] || die "missing host tools: ${missing[*]}"

  if ! kubectl get nodes >/dev/null 2>&1; then
    warn "kubectl cannot reach a cluster; Kamiwaza extension deployment will fail without it"
  fi

  # Sibling runtimes sharing a Pipelock port produce PF anchors whose
  # block rules drop each other's untrusted proxy traffic. Catch it before
  # any VM or cluster work happens.
  local env_file other_name other_port
  for env_file in "$OPENCLAW_RUNTIME_DIR/../"*/runtime.env; do
    [[ -f "$env_file" ]] || continue
    other_name="$(basename "$(dirname "$env_file")")"
    [[ "$other_name" != "$OPENCLAW_RUNTIME_NAME" ]] || continue
    other_port="$(grep -E '^OPENCLAW_PIPELOCK_PORT=' "$env_file" | cut -d= -f2 | tr -d "'\"")"
    if [[ "$other_port" == "$OPENCLAW_PIPELOCK_PORT" ]]; then
      die "runtime $other_name already uses Pipelock port $OPENCLAW_PIPELOCK_PORT. Pick a different --port-offset."
    fi
  done
}

probe_kamiwaza_reachable() {
  local out
  out="$(mktemp)"
  local status
  status="$(kamiwaza_api GET "/auth/health" "" "$out")"
  rm -f "$out"
  if [[ "$status" != "200" ]]; then
    die "Kamiwaza API is not reachable at $KAMIWAZA_API_URL (auth health returned $status). Set KAMIWAZA_API_URL or start Kamiwaza first."
  fi
  log "Kamiwaza API reachable at $KAMIWAZA_API_URL"
}

validate_kamiwaza_token() {
  local token="$1"
  local out
  out="$(mktemp)"
  local status
  status="$(kamiwaza_api GET "/auth/users/me" "$token" "$out")"
  if [[ "$status" != "200" ]]; then
    rm -f "$out"
    return 1
  fi
  local username
  username="$(json_field "$out" "username" 2>/dev/null || true)"
  rm -f "$out"
  log "Kamiwaza access validated${username:+ as $username}"
}

password_login_token() {
  # Prints an access token on success. Never prints the password.
  local username="$1"
  local password="$2"
  local out
  out="$(mktemp)"
  local status
  status="$(
    kamiwaza_api POST "/auth/token" "" "$out" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "username=$username" \
      --data-urlencode "password=$password"
  )"
  local token=""
  if [[ "$status" == "200" ]]; then
    token="$(json_field "$out" "access_token" || true)"
  fi
  rm -f "$out"
  [[ -n "$token" ]] || return 1
  printf '%s\n' "$token"
}

mint_pat() {
  # Exchanges a short-lived access token for a PAT. Prints the PAT.
  # /auth/pats takes query parameters, not a JSON body.
  local access_token="$1"
  local pat_name="${OPENCLAW_KAMIWAZA_PAT_NAME:-openclaw-$OPENCLAW_RUNTIME_NAME}"
  local ttl="${OPENCLAW_KAMIWAZA_PAT_TTL_SECONDS:-2592000}"
  [[ "$ttl" =~ ^[0-9]+$ ]] || die "OPENCLAW_KAMIWAZA_PAT_TTL_SECONDS must be numeric"
  local encoded_name
  encoded_name="$(jq -rn --arg v "$pat_name" '$v|@uri')"
  local out
  out="$(mktemp)"
  local status
  status="$(kamiwaza_api POST "/auth/pats?name=$encoded_name&ttl_seconds=$ttl" "$access_token" "$out")"
  if [[ "$status" != "200" && "$status" != "201" ]]; then
    rm -f "$out"
    die "failed to create a Kamiwaza PAT (HTTP $status)"
  fi
  local token
  token="$(json_field "$out" "token" || true)"
  rm -f "$out"
  [[ -n "$token" ]] || die "PAT creation response did not include a token"
  printf '%s\n' "$token"
}

resolve_password_noninteractive() {
  if [[ -n "${KAMIWAZA_PASSWORD:-}" ]]; then
    return 0
  fi
  local login_script="${OPENCLAW_KAMIWAZA_LOGIN_SCRIPT:-$HOME/code/kz/deploy/scripts/kz-login}"
  if [[ -x "$login_script" ]]; then
    local password
    password="$("$login_script" --show-password 2>/dev/null | tail -n 1 | tr -d '\r\n' || true)"
    if [[ -n "$password" ]]; then
      export KAMIWAZA_PASSWORD="$password"
      log "Kamiwaza password resolved from $login_script (value redacted)"
      return 0
    fi
  fi
  return 1
}

prompt_for_credentials() {
  is_interactive || die "no valid Kamiwaza credentials found. Set KAMIWAZA_API_KEY, or KAMIWAZA_USERNAME/KAMIWAZA_PASSWORD, or run interactively."

  local entered=""
  read -r -p "[openclaw turnkey] Enter a Kamiwaza API key, or press Enter to log in with username/password: " entered
  if [[ -n "$entered" ]]; then
    if validate_kamiwaza_token "$entered"; then
      KAMIWAZA_RESOLVED_TOKEN="$entered"
      KAMIWAZA_TOKEN_SOURCE="user-provided-key"
      return 0
    fi
    warn "that API key did not validate; falling back to username/password"
  fi

  local username="${KAMIWAZA_USERNAME:-admin}"
  read -r -p "[openclaw turnkey] Kamiwaza username [$username]: " entered
  [[ -n "$entered" ]] && username="$entered"
  local password=""
  read -rs -p "[openclaw turnkey] Kamiwaza password for $username: " password
  printf '\n'
  [[ -n "$password" ]] || die "empty password"

  local access_token
  access_token="$(password_login_token "$username" "$password")" ||
    die "Kamiwaza login failed for $username"
  log "login succeeded for $username; generating a PAT for OpenClaw"
  KAMIWAZA_RESOLVED_TOKEN="$(mint_pat "$access_token")"
  KAMIWAZA_TOKEN_SOURCE="generated-pat"
  export KAMIWAZA_USERNAME="$username"
  export KAMIWAZA_PASSWORD="$password"
}

resolve_kamiwaza_auth() {
  KAMIWAZA_RESOLVED_TOKEN=""
  KAMIWAZA_TOKEN_SOURCE=""

  if [[ -n "${KAMIWAZA_API_KEY:-}" ]]; then
    if validate_kamiwaza_token "$KAMIWAZA_API_KEY"; then
      KAMIWAZA_RESOLVED_TOKEN="$KAMIWAZA_API_KEY"
      KAMIWAZA_TOKEN_SOURCE="env-api-key"
      return 0
    fi
    warn "KAMIWAZA_API_KEY is set but did not validate against $KAMIWAZA_API_URL"
  fi

  local username="${KAMIWAZA_USERNAME:-admin}"
  if resolve_password_noninteractive; then
    local access_token
    if access_token="$(password_login_token "$username" "$KAMIWAZA_PASSWORD")"; then
      log "login succeeded for $username; generating a PAT for OpenClaw"
      KAMIWAZA_RESOLVED_TOKEN="$(mint_pat "$access_token")"
      KAMIWAZA_TOKEN_SOURCE="generated-pat"
      return 0
    fi
    warn "non-interactive Kamiwaza login failed for $username"
  fi

  prompt_for_credentials
}

# Globals set by select_deployed_model.
SELECTED_MODEL_NAME=""
SELECTED_MODEL_ACCESS_PATH=""

select_deployed_model() {
  local out
  out="$(mktemp)"
  local status
  status="$(kamiwaza_api GET "/serving/deployments" "$KAMIWAZA_RESOLVED_TOKEN" "$out")"
  [[ "$status" == "200" ]] || die "failed to list Kamiwaza model deployments (HTTP $status)"

  local deployed_json
  deployed_json="$(
    node -e '
      const fs = require("fs");
      const all = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const deployed = (Array.isArray(all) ? all : [])
        .filter((d) => d && d.status === "DEPLOYED" && typeof d.m_name === "string")
        .map((d) => ({ name: d.m_name, accessPath: d.access_path || "" }));
      process.stdout.write(JSON.stringify(deployed));
    ' "$out"
  )" || die "could not parse Kamiwaza deployments response"
  rm -f "$out"

  local count
  count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$deployed_json")"

  if [[ "$count" == "0" ]]; then
    warn "no Kamiwaza model is DEPLOYED"
    log "deploy a model first through the Kamiwaza UI (e.g. https://localhost), then re-run"
    if [[ "${OPENCLAW_KAMIWAZA_ALLOW_NO_MODEL:-0}" == "1" ]]; then
      log "OPENCLAW_KAMIWAZA_ALLOW_NO_MODEL=1 -> continuing without a model endpoint"
      return 0
    fi
    confirm_or_die "no deployed model means the OpenClaw agent has no brain" "OPENCLAW_KAMIWAZA_ALLOW_NO_MODEL=1"
    return 0
  fi

  log "deployed Kamiwaza models:"
  node -e '
    const deployed = JSON.parse(process.argv[1]);
    for (const d of deployed) console.log(`  - ${d.name}`);
  ' "$deployed_json"

  local wanted="${OPENCLAW_KAMIWAZA_MODEL_NAME:-}"
  local picked
  picked="$(
    node -e '
      const deployed = JSON.parse(process.argv[1]);
      const wanted = process.argv[2];
      const match = wanted ? deployed.find((d) => d.name === wanted) : deployed[0];
      if (!match) process.exit(1);
      process.stdout.write(JSON.stringify(match));
    ' "$deployed_json" "$wanted"
  )" || die "requested model ${wanted:-<first>} is not among the DEPLOYED models"

  SELECTED_MODEL_NAME="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).name)' "$picked")"
  SELECTED_MODEL_ACCESS_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).accessPath)' "$picked")"
  [[ -n "$SELECTED_MODEL_ACCESS_PATH" ]] || die "deployment for $SELECTED_MODEL_NAME has no access_path"
  log "selected model: $SELECTED_MODEL_NAME (access path $SELECTED_MODEL_ACCESS_PATH)"
}

verify_model_endpoint() {
  [[ -n "$SELECTED_MODEL_NAME" ]] || return 0
  local origin="${KAMIWAZA_API_URL%/api}"
  local url="$origin$SELECTED_MODEL_ACCESS_PATH/v1/models"
  local out
  out="$(mktemp)"
  local status
  status="$("$CURL_BIN" -sk -m 20 -H "Authorization: Bearer $KAMIWAZA_RESOLVED_TOKEN" "$url" -o "$out" -w '%{http_code}' 2>/dev/null || printf '000')"
  if [[ "$status" != "200" ]]; then
    rm -f "$out"
    die "model endpoint did not answer with the resolved credentials (HTTP $status at $url)"
  fi
  rm -f "$out"
  log "model endpoint verified with the resolved Kamiwaza credentials"
}

export_model_env() {
  [[ -n "$SELECTED_MODEL_NAME" ]] || return 0
  local origin="${KAMIWAZA_API_URL%/api}"
  local origin_scheme="${origin%%://*}"
  export OPENCLAW_KAMIWAZA_BASE_URL="$origin_scheme://$GUEST_API_HOST$SELECTED_MODEL_ACCESS_PATH/v1"
  export OPENCLAW_KAMIWAZA_MODEL_ID="$SELECTED_MODEL_NAME"
  export OPENCLAW_KAMIWAZA_MODEL_API_KEY="$KAMIWAZA_RESOLVED_TOKEN"
  log "model endpoint for guests: $OPENCLAW_KAMIWAZA_BASE_URL"
  log "model id: $OPENCLAW_KAMIWAZA_MODEL_ID"
}

write_pat_store_source() {
  openclaw_prepare_runtime_dirs
  local store_path="$OPENCLAW_RUNTIME_DIR/metadata/kamiwaza-pat-store-source.json"
  local credential_host
  credential_host="${OPENCLAW_KAMIWAZA_CREDENTIAL_HOST:-}"
  if [[ -z "$credential_host" ]]; then
    if command -v scutil >/dev/null 2>&1; then
      credential_host="$(scutil --get LocalHostName 2>/dev/null || true)"
    fi
    [[ -n "$credential_host" ]] || credential_host="$(hostname -s 2>/dev/null || printf 'localhost')"
    credential_host="$(printf '%s' "${credential_host%.local}" | tr '[:upper:]' '[:lower:]')"
  fi

  KAMIWAZA_STORE_TOKEN="$KAMIWAZA_RESOLVED_TOKEN" \
    KAMIWAZA_STORE_HOST="$credential_host" \
    KAMIWAZA_STORE_PATH="$store_path" \
    KAMIWAZA_STORE_TTL="${OPENCLAW_KAMIWAZA_PAT_TTL_SECONDS:-2592000}" \
    node -e '
      const fs = require("fs");
      const now = new Date();
      const ttlSeconds = Number(process.env.KAMIWAZA_STORE_TTL || 2592000);
      const expires = new Date(now.getTime() + ttlSeconds * 1000);
      const store = {
        format: "pdash-pat-store-v1",
        generated_at: now.toISOString(),
        source_host: process.env.KAMIWAZA_STORE_HOST,
        active_token_count: 1,
        active_tokens: [
          {
            token: process.env.KAMIWAZA_STORE_TOKEN,
            host_name: process.env.KAMIWAZA_STORE_HOST,
            scope: "write",
            source: "openclaw-turnkey",
            issued_at: now.toISOString(),
            expires_at: expires.toISOString(),
          },
        ],
      };
      fs.writeFileSync(process.env.KAMIWAZA_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    '
  chmod 600 "$store_path"
  export KAMIWAZA_PAT_STORE_SOURCE="$store_path"
  export OPENCLAW_KAMIWAZA_CREDENTIAL_HOST="$credential_host"
  log "wrote PAT store source for guest credential sync (path: $store_path)"
}

run_bootstrap() {
  log "handing off to bootstrap-kamiwaza-mode.sh"
  local cmd=(bash "$BOOTSTRAP_SCRIPT")
  if [[ "${#BOOTSTRAP_PASSTHROUGH[@]}" -gt 0 ]]; then
    cmd+=("${BOOTSTRAP_PASSTHROUGH[@]}")
  fi
  "${cmd[@]}"
}

print_summary() {
  log "turnkey install complete"
  log "gateway (host): http://127.0.0.1:$OPENCLAW_GATEWAY_HOST_PORT/"
  log "dashboard helper: bash scripts/dev/lima/dashboard-open.sh"
  log "guest shell: LIMA_HOME=$LIMA_HOME limactl shell $OPENCLAW_GATEWAY_INSTANCE"
  if [[ -n "$SELECTED_MODEL_NAME" ]]; then
    log "agent model: $SELECTED_MODEL_NAME via $OPENCLAW_KAMIWAZA_BASE_URL"
  else
    log "agent model: none configured (no deployed Kamiwaza model)"
  fi
  log "Kamiwaza credential source: $KAMIWAZA_TOKEN_SOURCE"
}

main() {
  check_host_prerequisites
  probe_kamiwaza_reachable
  resolve_kamiwaza_auth
  [[ -n "$KAMIWAZA_RESOLVED_TOKEN" ]] || die "could not resolve a usable Kamiwaza credential"
  select_deployed_model
  verify_model_endpoint
  export_model_env
  write_pat_store_source
  run_bootstrap
  print_summary
}

main
