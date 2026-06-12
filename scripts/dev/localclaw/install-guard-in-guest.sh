#!/usr/bin/env bash
# Runs INSIDE the localclaw guard guest. Installs tool-untrusted-content as a
# systemd service bound to guest loopback. Caller pipes this script in via
# `limactl shell <vm> -- env UTC_REPO_MOUNT=... bash -s`.
set -euo pipefail

log() { printf '[guard-install] %s\n' "$*"; }
die() { printf '[guard-install] error: %s\n' "$*" >&2; exit 1; }

UTC_REPO_MOUNT="${UTC_REPO_MOUNT:?set UTC_REPO_MOUNT to the read-only dep mount path}"
UTC_PORT="${UTC_PORT:-8787}"
[[ -f "$UTC_REPO_MOUNT/pyproject.toml" ]] || die "no pyproject.toml at $UTC_REPO_MOUNT (mount missing?)"

# The shared lima vmnet (lima0) installs a default route at a lower metric than
# the vz user-mode NAT (eth0), but only eth0 actually reaches the internet here.
# Drop the lima0 default route so apt/pip egress uses the working NAT. This only
# removes the broken default; lima0's subnet route stays, so guest-agent port
# forwarding (over SSH/vsock) is unaffected. No-op when lima0 has no default.
ensure_egress_route() {
  local lima_default eth_default
  lima_default="$(ip route show default dev lima0 2>/dev/null | head -n1 || true)"
  eth_default="$(ip route show default dev eth0 2>/dev/null | head -n1 || true)"
  if [[ -n "$lima_default" && -n "$eth_default" ]]; then
    log "dropping lima0 default route so egress uses vzNAT (eth0)"
    sudo ip route del default dev lima0 2>/dev/null || true
  fi
}
ensure_egress_route

log "installing system packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv python3-pip rsync curl

log "copying service source from read-only mount"
sudo mkdir -p /opt/untrusted-content
sudo rsync -a --delete --exclude .git --exclude var --exclude .venv \
  "$UTC_REPO_MOUNT/" /opt/untrusted-content/src/

log "creating service user and data root"
sudo useradd --system --shell /usr/sbin/nologin --home /var/lib/untrusted-content utc 2>/dev/null || true
sudo mkdir -p /var/lib/untrusted-content /etc/untrusted-content
sudo chown -R utc:utc /var/lib/untrusted-content

log "installing python package into venv"
sudo python3 -m venv /opt/untrusted-content/venv
sudo /opt/untrusted-content/venv/bin/pip install --quiet --upgrade pip
# Editable install: the venv imports directly from the rsynced source, so a
# re-run that updates /opt/untrusted-content/src takes effect on restart
# without pip skipping reinstall on an unchanged package version.
sudo /opt/untrusted-content/venv/bin/pip install --quiet -e /opt/untrusted-content/src

log "writing service environment"
# Stage fallbacks are forced to quarantine: this guard is load-bearing for a
# host-native agent, so a broken classifier must fail closed, not pass.
{
  echo "UTC_DATA_ROOT=/var/lib/untrusted-content"
  echo "UTC_GUARDRAIL_MODE=${UTC_GUARDRAIL_MODE:-heuristic}"
  echo "UTC_SCANNER_MODE=${UTC_SCANNER_MODE:-heuristic}"
  echo "UTC_GUARDRAIL_FALLBACK=quarantine"
  echo "UTC_SCANNER_FALLBACK=quarantine"
  # `if` (not `&& echo`): a trailing failed `[[ -n "" ]]` would make the brace
  # group exit non-zero and trip `set -e` when these optional vars are unset.
  if [[ -n "${UTC_GUARDRAIL_ENDPOINT:-}" ]]; then echo "UTC_GUARDRAIL_ENDPOINT=$UTC_GUARDRAIL_ENDPOINT"; fi
  if [[ -n "${UTC_GUARDRAIL_MODEL:-}" ]]; then echo "UTC_GUARDRAIL_MODEL=$UTC_GUARDRAIL_MODEL"; fi
  if [[ -n "${UTC_GUARDRAIL_API_KEY:-}" ]]; then echo "UTC_GUARDRAIL_API_KEY=$UTC_GUARDRAIL_API_KEY"; fi
  if [[ -n "${UTC_SCANNER_ENDPOINT:-}" ]]; then echo "UTC_SCANNER_ENDPOINT=$UTC_SCANNER_ENDPOINT"; fi
  if [[ -n "${UTC_SCANNER_MODEL:-}" ]]; then echo "UTC_SCANNER_MODEL=$UTC_SCANNER_MODEL"; fi
  if [[ -n "${UTC_SCANNER_API_KEY:-}" ]]; then echo "UTC_SCANNER_API_KEY=$UTC_SCANNER_API_KEY"; fi
} | sudo tee /etc/untrusted-content/untrusted-content.env >/dev/null
sudo chmod 0600 /etc/untrusted-content/untrusted-content.env

log "writing systemd unit"
sudo tee /etc/systemd/system/untrusted-content.service >/dev/null <<UNIT
[Unit]
Description=tool-untrusted-content guard service (localclaw)
After=network.target

[Service]
User=utc
Group=utc
EnvironmentFile=/etc/untrusted-content/untrusted-content.env
ExecStart=/opt/untrusted-content/venv/bin/untrusted-content server --host 127.0.0.1 --port ${UTC_PORT}
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/untrusted-content
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable untrusted-content.service
# Restart (not just start): on a re-run the unit is already active, so `start`
# is a no-op and a stale process keeps serving old source. Restart picks up
# the freshly rsynced/editable code and the regenerated unit.
sudo systemctl restart untrusted-content.service

log "waiting for health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${UTC_PORT}/health" >/dev/null 2>&1; then
    log "service healthy on 127.0.0.1:${UTC_PORT}"
    exit 0
  fi
  sleep 1
done
sudo systemctl status untrusted-content.service --no-pager || true
die "service did not become healthy within 30s"
