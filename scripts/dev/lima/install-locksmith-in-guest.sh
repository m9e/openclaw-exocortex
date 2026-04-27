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

configure_openclaw_hardened_config() {
  local token="$1"
  local ssh_target="${OPENCLAW_UNTRUSTED_SSH_TARGET:-}"
  local ssh_identity="${OPENCLAW_UNTRUSTED_SSH_IDENTITY:-$HOME/.ssh/openclaw_untrusted_ed25519}"
  local ssh_workspace_root="${OPENCLAW_UNTRUSTED_SSH_WORKSPACE_ROOT:-/tmp/openclaw-sandboxes}"
  local config_path="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
  mkdir -p "$(dirname "$config_path")"
  [[ -f "$config_path" ]] || printf '{}\n' >"$config_path"

  log "writing required Locksmith and per-agent tool policy"
  CONFIG_PATH="$config_path" \
  LOCKSMITH_TOKEN="$token" \
  OPENCLAW_UNTRUSTED_SSH_TARGET="$ssh_target" \
  OPENCLAW_UNTRUSTED_SSH_IDENTITY="$ssh_identity" \
  OPENCLAW_UNTRUSTED_SSH_WORKSPACE_ROOT="$ssh_workspace_root" \
    node <<'NODE'
const fs = require("fs");
const os = require("os");

const configPath = (process.env.CONFIG_PATH || "").replace(/^~(?=$|\/)/, os.homedir());
const locksmithToken = process.env.LOCKSMITH_TOKEN || "";
const untrustedSshTarget = (process.env.OPENCLAW_UNTRUSTED_SSH_TARGET || "").trim();
const untrustedSshIdentity = process.env.OPENCLAW_UNTRUSTED_SSH_IDENTITY || "";
const untrustedSshWorkspaceRoot =
  process.env.OPENCLAW_UNTRUSTED_SSH_WORKSPACE_ROOT || "/tmp/openclaw-sandboxes";

const trustedAllow = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "memory_search",
  "memory_get",
  "session_status",
  "update_plan",
  "message",
  "tts",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "agents_list",
  "locksmith_github",
];

const trustedDeny = [
  "group:runtime",
  "group:web",
  "group:ui",
  "group:automation",
  "group:nodes",
  "image",
  "image_generate",
  "music_generate",
  "video_generate",
  "sessions_list",
  "sessions_history",
  "locksmith_call",
];

const untrustedAllow = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "web_search",
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
  "session_status",
  "update_plan",
  "sessions_yield",
  "locksmith_github",
];

const untrustedDeny = [
  "group:ui",
  "group:automation",
  "group:nodes",
  "browser",
  "canvas",
  "gateway",
  "cron",
  "nodes",
  "message",
  "tts",
  "sessions_send",
  "sessions_list",
  "sessions_history",
  "agents_list",
  "subagents",
  "sessions_spawn",
  "image_generate",
  "music_generate",
  "video_generate",
  "locksmith_call",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureRecord(parent, key) {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function mergeList(existing, additions) {
  return uniqueStrings([...(Array.isArray(existing) ? existing : []), ...additions]);
}

function upsertAgent(agents, id) {
  const list = Array.isArray(agents.list) ? agents.list : [];
  agents.list = list;
  const found = list.find((entry) => isRecord(entry) && entry.id === id);
  if (found) {
    return found;
  }
  const created = { id };
  list.push(created);
  return created;
}

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  cfg = {};
}
if (!isRecord(cfg)) {
  cfg = {};
}

const plugins = ensureRecord(cfg, "plugins");
const pluginEntries = ensureRecord(plugins, "entries");
const locksmith = ensureRecord(pluginEntries, "locksmith");
locksmith.enabled = true;
const locksmithConfig = ensureRecord(locksmith, "config");
locksmithConfig.baseUrl = "http://127.0.0.1:9200";
locksmithConfig.inboundToken = locksmithToken;
locksmithConfig.required = true;
locksmithConfig.genericTool = false;
const locksmithTools = ensureRecord(locksmithConfig, "tools");
const githubTool = ensureRecord(locksmithTools, "github");
githubTool.enabled = true;
githubTool.description = "GitHub REST API exposed through required local Locksmith";

const tools = ensureRecord(cfg, "tools");
delete tools.allow;
delete tools.alsoAllow;
delete tools.deny;
const globalFs = ensureRecord(tools, "fs");
globalFs.workspaceOnly = true;
if (isRecord(tools.exec)) {
  delete tools.exec.security;
  if (Object.keys(tools.exec).length === 0) {
    delete tools.exec;
  }
}
if (isRecord(tools.web)) {
  for (const key of ["search", "fetch"]) {
    const section = tools.web[key];
    if (isRecord(section) && section.enabled === false) {
      delete section.enabled;
      if (Object.keys(section).length === 0) {
        delete tools.web[key];
      }
    }
  }
  if (Object.keys(tools.web).length === 0) {
    delete tools.web;
  }
}

const agents = ensureRecord(cfg, "agents");
const main = upsertAgent(agents, "main");
if (main.default === undefined) {
  main.default = true;
}
if (main.name === undefined) {
  main.name = "Trusted Gateway";
}
const mainTools = ensureRecord(main, "tools");
mainTools.allow = trustedAllow;
mainTools.deny = trustedDeny;
mainTools.fs = { ...(isRecord(mainTools.fs) ? mainTools.fs : {}), workspaceOnly: true };
mainTools.exec = { ...(isRecord(mainTools.exec) ? mainTools.exec : {}), security: "deny" };
const mainSubagents = ensureRecord(main, "subagents");
mainSubagents.allowAgents = mergeList(mainSubagents.allowAgents, ["main", "untrusted"]);

if (untrustedSshTarget) {
  const untrusted = upsertAgent(agents, "untrusted");
  if (untrusted.name === undefined) {
    untrusted.name = "Untrusted Sandbox";
  }
  const untrustedTools = ensureRecord(untrusted, "tools");
  untrustedTools.allow = untrustedAllow;
  untrustedTools.deny = untrustedDeny;
  untrustedTools.fs = {
    ...(isRecord(untrustedTools.fs) ? untrustedTools.fs : {}),
    workspaceOnly: true,
  };
  untrustedTools.exec = {
    ...(isRecord(untrustedTools.exec) ? untrustedTools.exec : {}),
    host: "sandbox",
    security: "full",
    ask: "off",
  };
  const sandboxTools = ensureRecord(ensureRecord(untrustedTools, "sandbox"), "tools");
  sandboxTools.allow = untrustedAllow;
  sandboxTools.deny = untrustedDeny;

  untrusted.sandbox = {
    ...(isRecord(untrusted.sandbox) ? untrusted.sandbox : {}),
    mode: "all",
    backend: "ssh",
    scope: "session",
    workspaceAccess: "rw",
    ssh: {
      ...(isRecord(untrusted.sandbox?.ssh) ? untrusted.sandbox.ssh : {}),
      target: untrustedSshTarget,
      workspaceRoot: untrustedSshWorkspaceRoot,
      strictHostKeyChecking: false,
      updateHostKeys: false,
      identityFile: untrustedSshIdentity,
    },
  };
  const untrustedSubagents = ensureRecord(untrusted, "subagents");
  untrustedSubagents.allowAgents = mergeList(untrustedSubagents.allowAgents, ["untrusted"]);
}

fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
NODE
}

enable_openclaw_plugin() {
  local token="$1"

  if ! openclaw_cli --version >/dev/null 2>&1; then
    log "openclaw helper not found on PATH; skipping plugin enablement"
    return
  fi

  configure_openclaw_hardened_config "$token"
  log "enabling OpenClaw locksmith plugin"
  openclaw_cli plugins enable locksmith >/dev/null
  openclaw_cli config get plugins.entries.locksmith.config.required >/dev/null
  openclaw_cli config get agents.list --json >/dev/null

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
