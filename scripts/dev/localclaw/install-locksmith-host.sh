#!/usr/bin/env bash
# install-locksmith-host.sh — PHASE 1 host-local Locksmith credential proxy
# for the trusted "localclaw" host claw.
#
# This is a deliberate v0. The upstream credentials live in a 0600 env file on
# the host (~/.config/locksmith/locksmith.env). This is accepted-insecure
# against a local-root threat model: anything running as this user can already
# read the file. Phase 2 relocates the proxy to a LAN box; phase 3 ports it to
# Kamiwaza. Until then, locksmithd just hides upstream secrets from the agent's
# own tool context — the agent calls locksmith_<tool>, never sees the key.
#
# What it does NOT do (out of scope for phase 1): no Kamiwaza provider block,
# no Pipelock/egress_proxy, no delegation, no untrusted-content. Tools use
# egress "direct" (host/LAN, no CONNECT proxy). The plugin is wired with
# required:false so a down locksmith never bricks the gateway.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"

LOCKSMITH_REPO="${LOCKSMITH_SOURCE_REPO:-$WORKSPACE_ROOT/deps/exocortex-agent-locksmith}"
CONFIG_DIR="$HOME/.config/locksmith"
ENV_FILE="$CONFIG_DIR/locksmith.env"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
BIN_DIR="$HOME/.local/bin"
LOCKSMITHD_BIN="$BIN_DIR/locksmithd"
RUN_WRAPPER="$BIN_DIR/locksmithd-run.sh"
OPENCLAW_ENV="$HOME/.openclaw/.env"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
PLIST_LABEL="com.exocortex.locksmith"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_FILE="$HOME/Library/Logs/locksmith.log"
LISTEN_HOST="127.0.0.1"
# Default 9202, not 9200: on hosts that already run the root openclaw-hardened
# boundary deployment, its locksmith-bridge (socat) owns 9200 and the boundary
# locksmithd owns 9201. The phase-1 host-local proxy is additive and must not
# collide with that stack, so it takes the next free port. Override with
# LOCKSMITH_PORT if 9202 is taken too.
LISTEN_PORT="${LOCKSMITH_PORT:-9202}"

log() { printf '[install-locksmith-host] %s\n' "$*"; }
die() {
  printf '[install-locksmith-host] error: %s\n' "$*" >&2
  exit 1
}

# --- preflight --------------------------------------------------------------
command -v cargo >/dev/null 2>&1 ||
  die "cargo not found — install Rust (https://rustup.rs: curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh) and re-run"
command -v corepack >/dev/null 2>&1 || die "corepack required (Node 22+)"
command -v openssl >/dev/null 2>&1 || die "openssl required to generate the inbound token"
command -v node >/dev/null 2>&1 || die "node required to wire the openclaw plugin config"
[[ -f "$LOCKSMITH_REPO/Cargo.toml" ]] ||
  die "agent-locksmith dep repo not found at $LOCKSMITH_REPO (set LOCKSMITH_SOURCE_REPO)"

log "locksmith dep repo: $LOCKSMITH_REPO"
log "listen: http://$LISTEN_HOST:$LISTEN_PORT"

# --- 1. build locksmithd ----------------------------------------------------
log "building locksmithd (cargo build --release --bin locksmithd; this can take a few minutes)"
(cd "$LOCKSMITH_REPO" && cargo build --release --bin locksmithd)
BUILT_BIN="$LOCKSMITH_REPO/target/release/locksmithd"
[[ -x "$BUILT_BIN" ]] || die "build did not produce $BUILT_BIN"

mkdir -p "$BIN_DIR"
install -m 0755 "$BUILT_BIN" "$LOCKSMITHD_BIN"
log "installed $LOCKSMITHD_BIN"

# --- 2. config dir ----------------------------------------------------------
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# --- 3. inbound token (preserve any existing creds in the env file) ---------
# Replace-or-append only the LOCKSMITH_INBOUND_TOKEN line so upstream creds the
# operator already set with `clawctl creds set` survive a re-run.
ensure_token_in_file() {
  local file="$1" token="$2"
  umask 177
  touch "$file"
  grep -vE '^LOCKSMITH_INBOUND_TOKEN=' "$file" >"$file.tmp" 2>/dev/null || true
  printf 'LOCKSMITH_INBOUND_TOKEN=%s\n' "$token" >>"$file.tmp"
  chmod 600 "$file.tmp"
  mv "$file.tmp" "$file"
}

read_token_from_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  grep -E '^LOCKSMITH_INBOUND_TOKEN=' "$file" | tail -n 1 | cut -d= -f2- || true
}

TOKEN="$(read_token_from_file "$ENV_FILE")"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  log "generated a new inbound token"
else
  log "reusing existing inbound token from $ENV_FILE"
fi
[[ "$TOKEN" =~ ^[A-Za-z0-9._~+-]+$ ]] || die "inbound token has unsupported characters"
ensure_token_in_file "$ENV_FILE" "$TOKEN"
log "inbound token stored in $ENV_FILE (0600)"

# Mirror the token into the gateway dotenv so the bundled locksmith plugin's
# env fallback (LOCKSMITH_INBOUND_TOKEN) resolves it — no secret literal in
# openclaw.json. The gateway loads ~/.openclaw/.env at startup.
mkdir -p "$(dirname "$OPENCLAW_ENV")"
ensure_token_in_file "$OPENCLAW_ENV" "$TOKEN"
log "inbound token mirrored into $OPENCLAW_ENV (0600)"

# --- 4. config.yaml (idempotent; never clobber operator-added tools) --------
# If config.yaml is absent, write the full host-local shape with tools: [].
# If it exists, leave it untouched so `clawctl tool add` entries survive —
# listen/inbound_auth are already present from the first write and never change
# in phase 1. (The operator adds upstreams via `clawctl tool add`.)
if [[ -f "$CONFIG_FILE" ]]; then
  log "config.yaml already present; leaving it (and any operator tools) untouched"
else
  umask 177
  cat >"$CONFIG_FILE" <<YAML
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
  chmod 600 "$CONFIG_FILE"
  log "wrote $CONFIG_FILE (0600, tools: [])"
fi

# --- 5. run wrapper (sources the 0600 env, then execs the daemon) -----------
# The secret stays in the 0600 env file, never in the plist. launchd execs the
# wrapper, which sources locksmith.env (so ${LOCKSMITH_INBOUND_TOKEN} and any
# upstream creds substitute at daemon startup) and replaces itself with the
# daemon.
umask 022
cat >"$RUN_WRAPPER" <<WRAP
#!/usr/bin/env bash
set -euo pipefail
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
exec "$LOCKSMITHD_BIN" --config "$CONFIG_FILE"
WRAP
chmod 755 "$RUN_WRAPPER"
log "wrote $RUN_WRAPPER"

# --- 6. LaunchAgent ---------------------------------------------------------
mkdir -p "$(dirname "$PLIST_PATH")" "$(dirname "$LOG_FILE")"
cat >"$PLIST_PATH" <<PLIST
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
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
PLIST
log "wrote LaunchAgent $PLIST_PATH (label $PLIST_LABEL)"

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"
launchctl start "$PLIST_LABEL" >/dev/null 2>&1 || true
log "loaded and started $PLIST_LABEL"

# --- 7. wire the bundled locksmith plugin into openclaw.json ----------------
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

// Projected locksmith_<slug> tools are registered optional; optional tools are
// policy-hidden from the agent unless explicitly opted in. alsoAllow adds them
// to the default tool set without converting to a restrictive allow-list.
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
[[ "$ok" == "1" ]] || die "locksmithd did not answer $HEALTH_URL — check $LOG_FILE"

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
log "next: add an upstream and its credential, e.g."
log "  scripts/dev/lima/clawctl tool add github --upstream https://api.github.com --auth-header Authorization --secret-env GITHUB_TOKEN --name localclaw"
log "  scripts/dev/lima/clawctl creds set GITHUB_TOKEN=- --name localclaw   # reads value from stdin"
