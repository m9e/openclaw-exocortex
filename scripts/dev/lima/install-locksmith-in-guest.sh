#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[openclaw locksmith guest install] %s\n' "$*"
}

die() {
  printf '[openclaw locksmith guest install] error: %s\n' "$*" >&2
  exit 1
}

assert_guest_context() {
  [[ "$(uname -s)" == "Linux" ]] || die "run this inside the Lima Linux guest"
  if [[ "${OPENCLAW_VM_ROLE:-}" != "gateway" ]]; then
    log "OPENCLAW_VM_ROLE is ${OPENCLAW_VM_ROLE:-unset}; continuing anyway"
  fi
}

resolve_arch() {
  case "$(uname -m)" in
    aarch64 | arm64) printf 'arm64\n' ;;
    x86_64 | amd64) printf 'amd64\n' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

download_locksmith() {
  local arch="$1"
  local version="${LOCKSMITH_VERSION:-latest}"
  local base_url
  if [[ "$version" == "latest" ]]; then
    base_url="https://github.com/SentientSwarm/agent-locksmith/releases/latest/download"
  else
    base_url="https://github.com/SentientSwarm/agent-locksmith/releases/download/$version"
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"

  log "downloading Locksmith $version for linux-$arch"
  curl -fsSLo "$tmpdir/locksmith" "$base_url/locksmith-linux-$arch"
  curl -fsSLo "$tmpdir/SHA256SUMS" "$base_url/SHA256SUMS"
  (cd "$tmpdir" && grep "locksmith-linux-$arch" SHA256SUMS | sed "s/locksmith-linux-$arch/locksmith/" | sha256sum -c -)

  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$tmpdir/locksmith" "$HOME/.local/bin/locksmith"
  rm -rf "$tmpdir"
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  printf '\n'
}

ensure_locksmith_token() {
  local config_dir="$HOME/.config/locksmith"
  mkdir -p "$config_dir"

  local env_file="$config_dir/locksmith.env"
  local token="${LOCKSMITH_INBOUND_TOKEN:-}"
  if [[ -z "$token" && -f "$env_file" ]]; then
    token="$(grep -E '^LOCKSMITH_INBOUND_TOKEN=' "$env_file" | tail -n 1 | cut -d= -f2-)"
  fi
  if [[ -z "$token" ]]; then
    token="$(generate_token)"
  fi
  [[ "$token" =~ ^[A-Za-z0-9._~+-]+$ ]] || die "LOCKSMITH_INBOUND_TOKEN contains unsupported characters"

  umask 077
  printf 'LOCKSMITH_INBOUND_TOKEN=%s\n' "$token" >"$env_file"
  chmod 600 "$env_file"
  printf '%s\n' "$token"
}

write_locksmith_config() {
  local config_dir="$HOME/.config/locksmith"
  mkdir -p "$config_dir"

  cat >"$config_dir/config.yaml" <<'YAML'
listen:
  host: "127.0.0.1"
  port: 9200

inbound_auth:
  mode: "bearer"
  token: "${LOCKSMITH_INBOUND_TOKEN}"

logging:
  level: "info"

tools:
  - name: "github"
    description: "GitHub REST API exposed through required local Locksmith"
    upstream: "https://api.github.com"
    cloud: true
    timeout_seconds: 30
YAML
  chmod 600 "$config_dir/config.yaml"
}

write_user_service() {
  local service_dir="$HOME/.config/systemd/user"
  mkdir -p "$service_dir"

  cat >"$service_dir/locksmith.service" <<'UNIT'
[Unit]
Description=Agent Locksmith local dev sidecar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/locksmith/locksmith.env
ExecStart=%h/.local/bin/locksmith --config %h/.config/locksmith/config.yaml
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable locksmith.service >/dev/null
  systemctl --user restart locksmith.service
}

openclaw_cli() {
  if [[ -n "${OPENCLAW_CLI:-}" ]]; then
    "$OPENCLAW_CLI" "$@"
    return
  fi
  if command -v openclaw >/dev/null 2>&1; then
    openclaw "$@"
    return
  fi
  if [[ -x "$HOME/bin/openclaw" ]]; then
    "$HOME/bin/openclaw" "$@"
    return
  fi
  return 127
}

enable_openclaw_plugin() {
  local token="$1"

  if ! openclaw_cli --version >/dev/null 2>&1; then
    log "openclaw helper not found on PATH; skipping plugin enablement"
    return
  fi

  log "enabling OpenClaw locksmith plugin"
  openclaw_cli plugins enable locksmith >/dev/null
  local batch_file
  batch_file="$(mktemp)"
  cat >"$batch_file" <<JSON
[
  {"path":"plugins.entries.locksmith.config.baseUrl","value":"http://127.0.0.1:9200"},
  {"path":"plugins.entries.locksmith.config.inboundToken","value":"$token"},
  {"path":"plugins.entries.locksmith.config.required","value":true},
  {"path":"plugins.entries.locksmith.config.genericTool","value":false},
  {"path":"plugins.entries.locksmith.config.tools.github.enabled","value":true},
  {"path":"plugins.entries.locksmith.config.tools.github.description","value":"GitHub REST API exposed through required local Locksmith"},
  {"path":"tools.fs.workspaceOnly","value":true},
  {"path":"tools.exec.security","value":"deny"},
  {"path":"tools.allow","value":["read","write","edit","apply_patch","memory_search","memory_get","session_status","update_plan","locksmith_github"]},
  {"path":"tools.alsoAllow","value":["locksmith_github"]},
  {"path":"tools.deny","value":["group:runtime","group:web","group:ui","group:messaging","group:automation","group:nodes","group:media","agents_list","sessions_list","sessions_history","sessions_send","sessions_spawn","sessions_yield","subagents","locksmith_call"]}
]
JSON
  openclaw_cli config set --batch-file "$batch_file" --strict-json >/dev/null
  rm -f "$batch_file"

  if openclaw_cli gateway status >/dev/null 2>&1; then
    log "restarting gateway so runtime plugin state is current"
    openclaw_cli gateway restart >/dev/null
  else
    log "gateway not running or not reachable; start it after install"
  fi
}

verify_install() {
  local token="$1"

  log "checking Locksmith service"
  systemctl --user is-active --quiet locksmith.service
  curl -fsS http://127.0.0.1:9200/health >/dev/null
  local unauth_status
  unauth_status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:9200/tools)"
  [[ "$unauth_status" == "401" || "$unauth_status" == "403" ]] || die "unauthenticated /tools returned $unauth_status"
  curl -fsS -H "Authorization: Bearer $token" http://127.0.0.1:9200/tools >/dev/null

  if openclaw_cli --version >/dev/null 2>&1; then
    log "checking OpenClaw locksmith CLI"
    openclaw_cli locksmith status
  fi
}

main() {
  assert_guest_context
  download_locksmith "$(resolve_arch)"
  local token
  token="$(ensure_locksmith_token)"
  write_locksmith_config
  write_user_service
  enable_openclaw_plugin "$token"
  verify_install "$token"

  log "installed binary: $HOME/.local/bin/locksmith"
  log "config: $HOME/.config/locksmith/config.yaml"
  log "env: $HOME/.config/locksmith/locksmith.env"
  log "service: systemctl --user status locksmith.service"
}

main "$@"
