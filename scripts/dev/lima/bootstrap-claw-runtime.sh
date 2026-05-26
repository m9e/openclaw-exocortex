#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/claw-runtime-env.sh"

RUN_INSTALL=1
RUN_CREDENTIAL_SYNC=1
RUN_GATEWAY_SERVICE=1
RUN_VERIFY=1

usage() {
  cat <<'USAGE'
Usage: scripts/dev/lima/bootstrap-claw-runtime.sh [options]

Creates and configures one OpenClaw Lima VM pair under claw-runtime/<name>.

Environment:
  OPENCLAW_RUNTIME_NAME          Runtime name, default openclaw.
  OPENCLAW_RUNTIME_DIR           Runtime folder, default ../claw-runtime/<name>.
  OPENCLAW_RUNTIME_PORT_OFFSET   Numeric offset added to default host ports.
  OPENCLAW_GATEWAY_INSTANCE      Override gateway Lima instance name.
  OPENCLAW_UNTRUSTED_INSTANCE    Override untrusted Lima instance name.
  OPENCLAW_PIPELOCK_PORT         Override host-forwarded Pipelock port.
  OPENCLAW_PIPELOCK_GUEST_PORT   Override gateway guest Pipelock port.

Options:
  --no-install                   Only create/start VMs.
  --no-credentials               Skip Kamiwaza PAT credential sync.
  --no-gateway-service           Do not start the gateway user service.
  --no-verify                    Skip post-bootstrap health checks.
  -h, --help                     Show this help.

Example second pair:
  OPENCLAW_RUNTIME_NAME=claw2 OPENCLAW_RUNTIME_PORT_OFFSET=1000 \
    scripts/dev/lima/bootstrap-claw-runtime.sh
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install)
      RUN_INSTALL=0
      shift
      ;;
    --no-credentials)
      RUN_CREDENTIAL_SYNC=0
      shift
      ;;
    --no-gateway-service)
      RUN_GATEWAY_SERVICE=0
      shift
      ;;
    --no-verify)
      RUN_VERIFY=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '[openclaw claw-runtime] error: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() {
  printf '[openclaw claw-runtime] %s\n' "$*"
}

run_in_gateway() {
  limactl shell "$OPENCLAW_GATEWAY_INSTANCE" -- "$@"
}

default_kamiwaza_credential_host() {
  if [[ -n "${OPENCLAW_KAMIWAZA_CREDENTIAL_HOST:-}" ]]; then
    printf '%s\n' "$OPENCLAW_KAMIWAZA_CREDENTIAL_HOST"
    return
  fi
  local local_host=""
  if command -v scutil >/dev/null 2>&1; then
    local_host="$(scutil --get LocalHostName 2>/dev/null || true)"
  fi
  if [[ -z "$local_host" ]]; then
    local_host="$(hostname -s 2>/dev/null || true)"
  fi
  local_host="${local_host%.local}"
  printf '%s\n' "$local_host" | tr '[:upper:]' '[:lower:]'
}

start_vms() {
  openclaw_prepare_runtime_dirs
  log "runtime scope"
  openclaw_runtime_summary
  bash "$SCRIPT_DIR/start-openclaw-vms.sh"
}

prefer_gateway_slirp_egress() {
  log "preferring gateway slirp egress before install"
  run_in_gateway sudo bash -s <<'REMOTE'
set -euo pipefail

cat >/etc/systemd/system/openclaw-gateway-egress-route.service <<'UNIT'
[Unit]
Description=Prefer Lima slirp egress for OpenClaw gateway downloads
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/openclaw-gateway-egress-route
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT

cat >/usr/local/sbin/openclaw-gateway-egress-route <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
slirp_gateway="$(ip route show default dev eth0 | awk '{ print $3; exit }')"
if [[ -n "$slirp_gateway" ]]; then
  ip route replace default via "$slirp_gateway" dev eth0 metric 50 || true
fi
SCRIPT
chmod 0755 /usr/local/sbin/openclaw-gateway-egress-route
systemctl daemon-reload
systemctl enable --now openclaw-gateway-egress-route.service >/dev/null
REMOTE
}

install_gateway() {
  log "installing OpenClaw checkout, Pipelock, and Locksmith in $OPENCLAW_GATEWAY_INSTANCE"
  prefer_gateway_slirp_egress
  run_in_gateway env \
    "OPENCLAW_GATEWAY_HOST_PORT=$OPENCLAW_GATEWAY_HOST_PORT" \
    "OPENCLAW_PIPELOCK_PORT=$OPENCLAW_PIPELOCK_PORT" \
    "OPENCLAW_PIPELOCK_GUEST_PORT=$OPENCLAW_PIPELOCK_GUEST_PORT" \
    "OPENCLAW_KAMIWAZA_CREDENTIAL_HOST=$(default_kamiwaza_credential_host)" \
    bash "$OPENCLAW_REPO_ROOT/scripts/dev/lima/install-in-guest.sh"
}

configure_untrusted() {
  log "configuring untrusted sandbox and host egress guard"
  bash "$SCRIPT_DIR/configure-untrusted-sandbox.sh"
}

sync_kamiwaza_credentials() {
  if [[ "$RUN_CREDENTIAL_SYNC" != "1" ]]; then
    log "skipping Kamiwaza credential sync"
    return
  fi

  local sync_script="$OPENCLAW_WORKSPACE_ROOT/sync-kamiwaza-pat-credentials.sh"
  local source_path="${KAMIWAZA_PAT_STORE_SOURCE:-/Users/yod/code/kzproxy/incoming/pdash-pat-store.json}"
  if [[ ! -x "$sync_script" || ! -f "$source_path" ]]; then
    log "skipping Kamiwaza credential sync; helper or source file missing"
    return
  fi

  log "syncing Kamiwaza PAT credentials into $OPENCLAW_GATEWAY_INSTANCE"
  local sync_log="$OPENCLAW_RUNTIME_DIR/metadata/kamiwaza-pat-sync.log"
  local sync_json="$OPENCLAW_RUNTIME_DIR/metadata/kamiwaza-pat-sync.json"
  local sync_tmp="$sync_json.tmp"
  OPENCLAW_GATEWAY_INSTANCE="$OPENCLAW_GATEWAY_INSTANCE" \
    KAMIWAZA_PAT_STORE_SOURCE="$source_path" \
    bash "$sync_script" --instance "$OPENCLAW_GATEWAY_INSTANCE" --source "$source_path" |
    tee "$sync_log"
  awk 'capture || /^\{/ { capture = 1; print }' "$sync_log" >"$sync_tmp"
  jq . "$sync_tmp" >"$sync_json"
  rm -f "$sync_tmp"
  refresh_locksmith_kamiwaza_env
  refresh_locksmith_kamiwaza_projections
}

refresh_locksmith_kamiwaza_env() {
  log "refreshing Locksmith Kamiwaza PAT environment"
  run_in_gateway env \
    "OPENCLAW_KAMIWAZA_CREDENTIAL_HOST=$(default_kamiwaza_credential_host)" \
    python3 - <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse


def normalize_hosts(value: str | None) -> list[str]:
    if not value:
        return []
    value = value.strip().lower()
    if not value:
        return []
    hosts = [value]
    if value.endswith(".local"):
        hosts.append(value[:-6])
    return hosts


def host_from_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value)
    return parsed.hostname.lower() if parsed.hostname else None


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            values[key] = value.strip()
    return values


def credential_hosts(record: dict) -> set[str]:
    hosts: set[str] = set()
    for host in normalize_hosts(str(record.get("host_name") or "")):
        hosts.add(host)
    aliases = record.get("aliases")
    if isinstance(aliases, list):
        for alias in aliases:
            if isinstance(alias, str):
                for host in normalize_hosts(alias):
                    hosts.add(host)
    issuer = record.get("issuer")
    if isinstance(issuer, str):
        for host in normalize_hosts(host_from_url(issuer)):
            hosts.add(host)
    return hosts


def credential_records(store: dict) -> list[dict]:
    for key in ("credentials", "active_tokens"):
        records = store.get(key)
        if isinstance(records, list):
            return [record for record in records if isinstance(record, dict)]
    return []


def store_source_host(store: dict) -> str | None:
    source = store.get("source") if isinstance(store.get("source"), dict) else {}
    source_host = source.get("source_host") if isinstance(source, dict) else None
    if isinstance(source_host, str):
        return source_host
    top_level_source_host = store.get("source_host")
    return top_level_source_host if isinstance(top_level_source_host, str) else None


def select_token(store: dict) -> str | None:
    usable = [
        record
        for record in credential_records(store)
        if isinstance(record, dict) and isinstance(record.get("token"), str) and record["token"].strip()
    ]
    if not usable:
        return None
    desired_host_groups: list[set[str]] = []
    for candidates in (
        (os.environ.get("OPENCLAW_KAMIWAZA_CREDENTIAL_HOST"),),
        (store_source_host(store),),
    ):
        desired_hosts: set[str] = set()
        for candidate in candidates:
            if isinstance(candidate, str):
                desired_hosts.update(normalize_hosts(candidate))
        if desired_hosts:
            desired_host_groups.append(desired_hosts)
    for desired_hosts in desired_host_groups:
        for record in usable:
            if credential_hosts(record) & desired_hosts:
                return str(record["token"]).strip()
    if len(usable) == 1:
        return str(usable[0]["token"]).strip()
    return None


home = Path.home()
env_path = home / ".config" / "locksmith" / "locksmith.env"
store_path = home / ".openclaw" / "credentials" / "kamiwaza-pat-store.json"
if not store_path.exists():
    raise SystemExit("Kamiwaza PAT store is not present; cannot refresh Locksmith")

store = json.loads(store_path.read_text(encoding="utf-8"))
token = select_token(store)
if not token:
    raise SystemExit("could not select a Kamiwaza PAT for Locksmith")

values = read_env_file(env_path)
values["KAMIWAZA_API_KEY"] = token
ordered_keys = [
    "LOCKSMITH_INBOUND_TOKEN",
    "KAMIWAZA_DELEGATION_SIGNING_SECRET",
    "KAMIWAZA_API_KEY",
]
lines = [f"{key}={values[key]}" for key in ordered_keys if values.get(key)]
for key in sorted(k for k in values if k not in ordered_keys):
    lines.append(f"{key}={values[key]}")
env_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
tmp = env_path.with_name(f".{env_path.name}.tmp")
tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
os.chmod(tmp, 0o600)
tmp.replace(env_path)
os.chmod(env_path, 0o600)
print("Locksmith Kamiwaza PAT environment refreshed")
PY
  run_in_gateway bash -lc 'systemctl --user restart locksmith.service'
}

refresh_locksmith_kamiwaza_projections() {
  log "refreshing first-class Locksmith projections for active Kamiwaza tools"
  run_in_gateway python3 - <<'PY'
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            values[key] = value.strip()
    return values


def read_json_file(path: Path) -> dict:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return {}


def ensure_record(parent: dict, key: str) -> dict:
    value = parent.get(key)
    if not isinstance(value, dict):
        value = {}
        parent[key] = value
    return value


def fetch_locksmith_tools(token: str) -> list[dict]:
    request = urllib.request.Request(
        "http://127.0.0.1:9200/tools",
        headers={"Authorization": f"Bearer {token}"},
    )
    last_error: Exception | None = None
    for _ in range(20):
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            tools = payload.get("tools") if isinstance(payload, dict) else None
            return [tool for tool in tools if isinstance(tool, dict)] if isinstance(tools, list) else []
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(0.5)
    print(f"skipping Kamiwaza projection refresh; Locksmith tools unavailable: {last_error}")
    return []


home = Path.home()
env = read_env_file(home / ".config" / "locksmith" / "locksmith.env")
token = env.get("LOCKSMITH_INBOUND_TOKEN", "").strip()
if not token:
    print("skipping Kamiwaza projection refresh; missing Locksmith inbound token")
    raise SystemExit(0)

active_tools = [
    tool
    for tool in fetch_locksmith_tools(token)
    if isinstance(tool.get("name"), str) and tool["name"].startswith("kamiwaza_")
]
if not active_tools:
    print("no active Kamiwaza Locksmith tools to project")
    raise SystemExit(0)

config_path = home / ".openclaw" / "openclaw.json"
cfg = read_json_file(config_path)
plugins = ensure_record(cfg, "plugins")
entries = ensure_record(plugins, "entries")
locksmith = ensure_record(entries, "locksmith")
locksmith["enabled"] = True
locksmith_config = ensure_record(locksmith, "config")
tools_config = ensure_record(locksmith_config, "tools")

changed = False
projected = 0
for tool in active_tools:
    slug = str(tool["name"])
    existing = tools_config.get(slug)
    if not isinstance(existing, dict):
        existing = {}
    if existing.get("enabled") is False:
        continue
    next_entry = dict(existing)
    if next_entry.get("enabled") is not True:
        next_entry["enabled"] = True
        changed = True
    if not isinstance(next_entry.get("mode"), str):
        next_entry["mode"] = "json"
        changed = True
    if not isinstance(next_entry.get("method"), str):
        next_entry["method"] = "POST"
        changed = True
    description = tool.get("description")
    if isinstance(description, str) and description.strip() and not isinstance(next_entry.get("description"), str):
        next_entry["description"] = description.strip()
        changed = True
    input_schema = tool.get("inputSchema")
    if isinstance(input_schema, dict) and not isinstance(next_entry.get("parameters"), dict):
        next_entry["parameters"] = input_schema
        changed = True
    if tools_config.get(slug) != next_entry:
        tools_config[slug] = next_entry
        changed = True
    projected += 1

if changed:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = config_path.with_name(f".{config_path.name}.tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(config_path)
    os.chmod(config_path, 0o600)

print(f"projected {projected} active Kamiwaza Locksmith tool(s)")
PY
}

configure_kamiwaza_provider() {
  local provider_id="${OPENCLAW_KAMIWAZA_PROVIDER_ID:-kamiwaza-local}"
  local model_id="${OPENCLAW_KAMIWAZA_MODEL_ID:-kamiwaza/relic/MiniMax-M2.7-AWQ-4bit}"
  local base_url="${OPENCLAW_KAMIWAZA_BASE_URL:-http://host.lima.internal:4000/v1}"

  log "configuring local Kamiwaza provider $provider_id for $model_id"
  run_in_gateway env \
    "OPENCLAW_KAMIWAZA_PROVIDER_ID=$provider_id" \
    "OPENCLAW_KAMIWAZA_MODEL_ID=$model_id" \
    "OPENCLAW_KAMIWAZA_BASE_URL=$base_url" \
    node <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  cfg = {};
}
if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
  cfg = {};
}

const providerId = process.env.OPENCLAW_KAMIWAZA_PROVIDER_ID || "kamiwaza-local";
const modelId = process.env.OPENCLAW_KAMIWAZA_MODEL_ID || "kamiwaza/relic/MiniMax-M2.7-AWQ-4bit";
const baseUrl = process.env.OPENCLAW_KAMIWAZA_BASE_URL || "http://host.lima.internal:4000/v1";
const modelRef = `${providerId}/${modelId}`;

cfg.models = cfg.models && typeof cfg.models === "object" && !Array.isArray(cfg.models)
  ? cfg.models
  : {};
cfg.models.mode = "merge";
cfg.models.providers = cfg.models.providers &&
  typeof cfg.models.providers === "object" &&
  !Array.isArray(cfg.models.providers)
    ? cfg.models.providers
    : {};
cfg.models.providers[providerId] = {
  baseUrl,
  apiKey: "openclaw-local-kamiwaza",
  api: "openai-completions",
  models: [
    {
      id: modelId,
      name: "Kamiwaza Relic MiniMax M2.7 AWQ 4-bit",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      agentRuntime: { id: "pi" },
    },
  ],
};

cfg.agents = cfg.agents && typeof cfg.agents === "object" && !Array.isArray(cfg.agents)
  ? cfg.agents
  : {};
cfg.agents.defaults = cfg.agents.defaults &&
  typeof cfg.agents.defaults === "object" &&
  !Array.isArray(cfg.agents.defaults)
    ? cfg.agents.defaults
    : {};
cfg.agents.defaults.models = cfg.agents.defaults.models &&
  typeof cfg.agents.defaults.models === "object" &&
  !Array.isArray(cfg.agents.defaults.models)
    ? cfg.agents.defaults.models
    : {};
cfg.agents.defaults.models[modelRef] = {
  alias: "Kamiwaza MiniMax M2.7",
  agentRuntime: { id: "pi" },
};

fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
NODE
}

start_gateway_service() {
  if [[ "$RUN_GATEWAY_SERVICE" != "1" ]]; then
    log "skipping gateway service start"
    return
  fi

  log "starting gateway user service in $OPENCLAW_GATEWAY_INSTANCE"
  run_in_gateway env \
    "OPENCLAW_GATEWAY_PORT=18789" \
    "OPENCLAW_PIPELOCK_GUEST_PORT=$OPENCLAW_PIPELOCK_GUEST_PORT" \
    "OPENCLAW_PIPELOCK_PORT=$OPENCLAW_PIPELOCK_PORT" \
    bash -lc '
set -euo pipefail
mkdir -p "$HOME/.config/systemd/user" "$HOME/.openclaw"
cat >"$HOME/.config/systemd/user/openclaw-gateway-dev.service" <<SERVICE
[Unit]
Description=OpenClaw gateway dev runtime
After=network-online.target locksmith.service
Wants=network-online.target locksmith.service

[Service]
Type=simple
Environment=OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT:-18789}
Environment=OPENCLAW_PIPELOCK_GUEST_PORT=${OPENCLAW_PIPELOCK_GUEST_PORT:-8888}
Environment=OPENCLAW_PIPELOCK_PORT=${OPENCLAW_PIPELOCK_PORT:-29888}
ExecStart=%h/bin/openclaw-gateway-dev
Restart=on-failure
RestartSec=3
WorkingDirectory=%h/code/openclaw-exocortex

[Install]
WantedBy=default.target
SERVICE
systemctl --user daemon-reload
systemctl --user enable openclaw-gateway-dev.service >/dev/null
systemctl --user restart openclaw-gateway-dev.service
'
}

verify_runtime() {
  if [[ "$RUN_VERIFY" != "1" ]]; then
    log "skipping verification"
    return
  fi

  log "verifying gateway, Locksmith, and model catalog"
  run_in_gateway env \
    "OPENCLAW_GATEWAY_PORT=18789" \
    "OPENCLAW_KAMIWAZA_PROVIDER_ID=${OPENCLAW_KAMIWAZA_PROVIDER_ID:-kamiwaza-local}" \
    "OPENCLAW_KAMIWAZA_MODEL_ID=${OPENCLAW_KAMIWAZA_MODEL_ID:-kamiwaza/relic/MiniMax-M2.7-AWQ-4bit}" \
    bash -lc '
set -euo pipefail
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/health"

source "$HOME/.config/locksmith/locksmith.env"
curl -fsS \
  -H "Authorization: Bearer ${LOCKSMITH_INBOUND_TOKEN:?missing Locksmith inbound token}" \
  "http://127.0.0.1:9200/tools" |
  jq -e ".tools | type == \"array\"" >/dev/null

jq -e \
  --arg provider "${OPENCLAW_KAMIWAZA_PROVIDER_ID:-kamiwaza-local}" \
  --arg model "${OPENCLAW_KAMIWAZA_MODEL_ID:-kamiwaza/relic/MiniMax-M2.7-AWQ-4bit}" \
  ".models.providers[\$provider].models[]? | select(.id == \$model)" \
  "$HOME/.openclaw/openclaw.json" >/dev/null
'
}

start_vms
if [[ "$RUN_INSTALL" == "1" ]]; then
  install_gateway
  configure_untrusted
  sync_kamiwaza_credentials
  configure_kamiwaza_provider
  start_gateway_service
  verify_runtime
else
  log "skipping install/configure phase"
fi

log "bootstrap complete"
openclaw_runtime_summary
