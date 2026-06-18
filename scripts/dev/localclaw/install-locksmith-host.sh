#!/usr/bin/env bash
# install-locksmith-host.sh — PHASE 1 host-local Locksmith credential proxy
# for the trusted "localclaw" host claw.
#
# This installs Locksmith as a ROOT LaunchDaemon with ROOT-OWNED credentials.
# The upstream credentials live in a 0600 root:wheel env file under
# /usr/local/etc/locksmith (the dir is 0700 root, so the `yod` agent cannot even
# traverse it). The hardening over the old user-mode v0: now only a root privesc
# can read the upstream secrets — a meaningful step up from a user-readable file.
# Phase 2 relocates the proxy to a LAN box; phase 3 ports it to Kamiwaza. Until
# then, locksmithd hides upstream secrets from the agent's own tool context —
# the agent calls locksmith_<tool>, never sees the key.
#
# What it does NOT do (out of scope for phase 1): no Kamiwaza provider block,
# no Pipelock/egress_proxy, no delegation, no untrusted-content. Tools use
# egress "direct" (host/LAN, no CONNECT proxy). The plugin is wired with
# required:false so a down locksmith never bricks the gateway.
#
# Idempotent: re-running on a live root setup is safe — it preserves the
# existing inbound token, never clobbers operator-added upstream creds or tools,
# and only re-applies the binary/wrapper/plist/config skeleton.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"

LOCKSMITH_REPO="${LOCKSMITH_SOURCE_REPO:-$WORKSPACE_ROOT/deps/exocortex-agent-locksmith}"

# Root model paths (all root:wheel; CONFIG_DIR is 0700 so yod cannot traverse).
CONFIG_DIR="/usr/local/etc/locksmith"
ENV_FILE="$CONFIG_DIR/locksmith.env"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
LOCKSMITHD_BIN="/usr/local/bin/locksmithd"
RUN_WRAPPER="/usr/local/bin/locksmithd-run.sh"
LOG_DIR="/var/log/locksmith"
PLIST_LABEL="com.exocortex.locksmith"
PLIST_PATH="/Library/LaunchDaemons/$PLIST_LABEL.plist"

# yod-owned gateway files (no sudo).
OPENCLAW_ENV="$HOME/.openclaw/.env"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

LISTEN_HOST="127.0.0.1"
# The root daemon is canonical on 9200 (loopback). LOCKSMITH_PORT override is
# kept for odd setups, but the live deployment is always 9200.
LISTEN_PORT="${LOCKSMITH_PORT:-9200}"

log() { printf '[install-locksmith-host] %s\n' "$*"; }
die() {
  printf '[install-locksmith-host] error: %s\n' "$*" >&2
  exit 1
}

# Warn before a sudo call when no creds are cached so the password prompt is not
# a surprise. We never suppress the prompt (root-owned creds need real sudo).
sudo_note() {
  sudo -n true 2>/dev/null && return 0
  log "this installer needs sudo (Locksmith runs as a root LaunchDaemon with root-owned creds); you'll be prompted"
}

# --- preflight --------------------------------------------------------------
command -v cargo >/dev/null 2>&1 ||
  die "cargo not found — install Rust (https://rustup.rs: curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh) and re-run"
command -v corepack >/dev/null 2>&1 || die "corepack required (Node 22+)"
command -v openssl >/dev/null 2>&1 || die "openssl required to generate the inbound token"
command -v node >/dev/null 2>&1 || die "node required to wire the openclaw plugin config"
command -v sudo >/dev/null 2>&1 || die "sudo required (root LaunchDaemon + root-owned creds)"
[[ -f "$LOCKSMITH_REPO/Cargo.toml" ]] ||
  die "agent-locksmith dep repo not found at $LOCKSMITH_REPO (set LOCKSMITH_SOURCE_REPO)"

log "locksmith dep repo: $LOCKSMITH_REPO"
log "listen: http://$LISTEN_HOST:$LISTEN_PORT (root LaunchDaemon)"
sudo_note

# --- 1. build + install locksmithd (root:wheel) -----------------------------
log "building locksmithd (cargo build --release --bin locksmithd; this can take a few minutes)"
(cd "$LOCKSMITH_REPO" && cargo build --release --bin locksmithd)
BUILT_BIN="$LOCKSMITH_REPO/target/release/locksmithd"
[[ -x "$BUILT_BIN" ]] || die "build did not produce $BUILT_BIN"

sudo install -m 0755 -o root -g wheel "$BUILT_BIN" "$LOCKSMITHD_BIN"
log "installed $LOCKSMITHD_BIN (root:wheel 0755)"

# --- 2. root dirs -----------------------------------------------------------
# 0700 config dir: yod cannot traverse it, so the creds/config are unreadable
# without root. 0750 log dir keeps logs off the agent's eyes too.
sudo install -d -m 0700 -o root -g wheel "$CONFIG_DIR"
sudo install -d -m 0750 -o root -g wheel "$LOG_DIR"

# --- 3. inbound token (preserve existing token + operator upstream creds) ----
# Reuse the existing LOCKSMITH_INBOUND_TOKEN if the root env file already has one
# (idempotent); otherwise generate a fresh one. Then replace-or-append ONLY the
# token line in the root env file (sudo), preserving any operator-added upstream
# secrets. Finally mirror the token into the yod-readable gateway dotenv.
TOKEN="$(sudo grep -E '^LOCKSMITH_INBOUND_TOKEN=' "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  log "generated a new inbound token"
else
  log "reusing existing inbound token from $ENV_FILE"
fi
[[ "$TOKEN" =~ ^[A-Za-z0-9._~+-]+$ ]] || die "inbound token has unsupported characters"

# Replace-or-append the token in the root env file via sudo (root:wheel 0600).
sudo LOCKSMITH_INBOUND_TOKEN_VALUE="$TOKEN" ENV_FILE="$ENV_FILE" bash -c '
  set -euo pipefail
  umask 077
  tmp="$(mktemp)"
  grep -vE "^LOCKSMITH_INBOUND_TOKEN=" "$ENV_FILE" 2>/dev/null >"$tmp" || true
  printf "LOCKSMITH_INBOUND_TOKEN=%s\n" "$LOCKSMITH_INBOUND_TOKEN_VALUE" >>"$tmp"
  install -m 0600 -o root -g wheel "$tmp" "$ENV_FILE"
  rm -f "$tmp"
'
log "inbound token stored in $ENV_FILE (root:wheel 0600)"

# Mirror ONLY the inbound token into the yod-owned gateway dotenv so the bundled
# locksmith plugin's env fallback resolves it. This authorizes CALLING locksmith,
# never reading upstream secrets — those stay root-only in $ENV_FILE.
mkdir -p "$(dirname "$OPENCLAW_ENV")"
(
  umask 077
  touch "$OPENCLAW_ENV"
  tmp="$(mktemp)"
  grep -vE '^LOCKSMITH_INBOUND_TOKEN=' "$OPENCLAW_ENV" 2>/dev/null >"$tmp" || true
  printf 'LOCKSMITH_INBOUND_TOKEN=%s\n' "$TOKEN" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$OPENCLAW_ENV"
)
log "inbound token mirrored into $OPENCLAW_ENV (yod 0600)"

# --- 4. config.yaml (idempotent; never clobber operator-added tools) --------
# If config.yaml is absent, write the full host-local shape with tools: [].
# If it exists, leave it untouched so `clawctl tool add` entries survive —
# listen/inbound_auth are already present from the first write and never change
# in phase 1. (The operator adds upstreams via `clawctl tool add`.)
if sudo test -f "$CONFIG_FILE"; then
  log "config.yaml already present; leaving it (and any operator tools) untouched"
else
  sudo LISTEN_HOST="$LISTEN_HOST" LISTEN_PORT="$LISTEN_PORT" CONFIG_FILE="$CONFIG_FILE" bash -c '
    set -euo pipefail
    umask 022
    tmp="$(mktemp)"
    cat >"$tmp" <<YAML
listen:
  host: "$LISTEN_HOST"
  port: $LISTEN_PORT

inbound_auth:
  mode: "bearer"
  token: "\${LOCKSMITH_INBOUND_TOKEN}"

logging:
  level: "info"

shutdown:
  drain_window_seconds: 30

tools: []
YAML
    install -m 0644 -o root -g wheel "$tmp" "$CONFIG_FILE"
    rm -f "$tmp"
  '
  log "wrote $CONFIG_FILE (root:wheel 0644, tools: [])"
fi

# --- 5. run wrapper (sources the 0600 root env, then execs the daemon) -------
# The secret stays in the 0600 root env file, never in the plist. launchd execs
# the wrapper as root, which sources locksmith.env (so ${LOCKSMITH_INBOUND_TOKEN}
# and any upstream creds substitute at daemon startup) and replaces itself with
# the daemon.
sudo RUN_WRAPPER="$RUN_WRAPPER" ENV_FILE="$ENV_FILE" LOCKSMITHD_BIN="$LOCKSMITHD_BIN" \
  CONFIG_FILE="$CONFIG_FILE" bash -c '
  set -euo pipefail
  umask 077
  tmp="$(mktemp)"
  cat >"$tmp" <<WRAP
#!/bin/bash
set -a; source "$ENV_FILE"; set +a
exec "$LOCKSMITHD_BIN" --config "$CONFIG_FILE"
WRAP
  install -m 0700 -o root -g wheel "$tmp" "$RUN_WRAPPER"
  rm -f "$tmp"
'
log "wrote $RUN_WRAPPER (root:wheel 0700)"

# --- 6. LaunchDaemon (system domain) ----------------------------------------
sudo PLIST_PATH="$PLIST_PATH" PLIST_LABEL="$PLIST_LABEL" RUN_WRAPPER="$RUN_WRAPPER" \
  LOG_DIR="$LOG_DIR" CONFIG_DIR="$CONFIG_DIR" bash -c '
  set -euo pipefail
  tmp="$(mktemp)"
  cat >"$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUN_WRAPPER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/locksmith.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/locksmith.err.log</string>
  <key>WorkingDirectory</key>
  <string>$CONFIG_DIR</string>
</dict>
</plist>
PLIST
  install -m 0644 -o root -g wheel "$tmp" "$PLIST_PATH"
  rm -f "$tmp"
'
log "wrote LaunchDaemon $PLIST_PATH (label $PLIST_LABEL)"

# Re-bootstrap the system-domain job so the new plist/wrapper/binary take effect.
sudo launchctl bootout system/"$PLIST_LABEL" >/dev/null 2>&1 || true
sudo launchctl bootstrap system "$PLIST_PATH"
log "bootstrapped $PLIST_LABEL into the system domain"

# --- 7. wire the bundled locksmith plugin into openclaw.json (yod) ----------
# required:false — phase 1 locksmith is a convenience, not load-bearing; a down
# daemon must not brick the gateway. No inboundToken literal (env fallback). No
# kamiwaza block. genericTool:false hides the generic locksmith_call.
mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
[[ -f "$OPENCLAW_CONFIG" ]] || printf '{}\n' >"$OPENCLAW_CONFIG"
OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG" \
LOCKSMITH_BASE_URL="http://$LISTEN_HOST:$LISTEN_PORT" \
  node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");

const configPath = (process.env.OPENCLAW_CONFIG_PATH || "").replace(/^~(?=$|\/)/, os.homedir());
const baseUrl = process.env.LOCKSMITH_BASE_URL || "http://127.0.0.1:9200";

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ensureRecord = (parent, key) => {
  if (!isRecord(parent[key])) parent[key] = {};
  return parent[key];
};

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  cfg = {};
}
if (!isRecord(cfg)) cfg = {};

const plugins = ensureRecord(cfg, "plugins");
const entries = ensureRecord(plugins, "entries");
const locksmith = ensureRecord(entries, "locksmith");
locksmith.enabled = true;
const lc = ensureRecord(locksmith, "config");
lc.baseUrl = baseUrl;
// Phase 1: locksmith is a convenience, not load-bearing. Never brick the
// gateway when the daemon is down.
lc.required = false;
// Hide the generic locksmith_call; only projected locksmith_<slug> tools.
lc.genericTool = false;
lc.timeoutSeconds = 120;
lc.catalogTtlSeconds = 600;
// No inboundToken literal: the plugin resolves LOCKSMITH_INBOUND_TOKEN from
// the gateway dotenv. Preserve any operator-added tools.
if (!isRecord(lc.tools)) lc.tools = {};

// Restrictive profiles or explicit allow-lists can still hide projected
// locksmith_<slug> tools. alsoAllow keeps them available without converting to
// a restrictive allow-list.
const agents = ensureRecord(cfg, "agents");
const list = Array.isArray(agents.list) ? agents.list : (agents.list = []);
let main = list.find((a) => isRecord(a) && a.id === "main");
if (!main) {
  main = { id: "main" };
  list.push(main);
}
const mainTools = ensureRecord(main, "tools");
const also = new Set(Array.isArray(mainTools.alsoAllow) ? mainTools.alsoAllow : []);
also.add("locksmith_*");
mainTools.alsoAllow = [...also].sort();

fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
console.log(`[install-locksmith-host] wired plugins.entries.locksmith in ${configPath}`);
NODE
chmod 600 "$OPENCLAW_CONFIG"

# --- 8. verify (give launchd a moment to bind the port) ---------------------
HEALTH_URL="http://$LISTEN_HOST:$LISTEN_PORT/health"
TOOLS_URL="http://$LISTEN_HOST:$LISTEN_PORT/tools"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
[[ "$ok" == "1" ]] || die "locksmithd did not answer $HEALTH_URL — check $LOG_DIR/locksmith.err.log"

log "GET /health:"
curl -fsS -m 5 "$HEALTH_URL" || die "health check failed"
printf '\n'
log "GET /tools (authenticated):"
curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$TOOLS_URL" || die "tools check failed"
printf '\n'

# --- 9. restart the gateway so the plugin change takes effect ---------------
# Prefer doing it; tolerate the gateway being down (it is not load-bearing here).
if (cd "$REPO_ROOT" && corepack pnpm openclaw gateway restart) >/dev/null 2>&1; then
  log "restarted the host gateway to pick up the plugin change"
else
  log "could not restart the gateway (may be down); run 'corepack pnpm openclaw gateway restart' yourself"
fi

log "done."
log "next: add an upstream and its credential (both root-owned; clawctl uses sudo), e.g."
log "  scripts/dev/lima/clawctl tool add github --upstream https://api.github.com --auth-header Authorization --secret-env GITHUB_TOKEN --name localclaw"
log "  scripts/dev/lima/clawctl creds set GITHUB_TOKEN=- --name localclaw   # reads value from stdin"
