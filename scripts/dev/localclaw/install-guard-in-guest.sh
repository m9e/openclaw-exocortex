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
sudo /opt/untrusted-content/venv/bin/pip install --quiet /opt/untrusted-content/src

log "writing service environment"
# Stage fallbacks are forced to quarantine: this guard is load-bearing for a
# host-native agent, so a broken classifier must fail closed, not pass.
{
  echo "UTC_DATA_ROOT=/var/lib/untrusted-content"
  echo "UTC_GUARDRAIL_MODE=${UTC_GUARDRAIL_MODE:-heuristic}"
  echo "UTC_SCANNER_MODE=${UTC_SCANNER_MODE:-heuristic}"
  echo "UTC_GUARDRAIL_FALLBACK=quarantine"
  echo "UTC_SCANNER_FALLBACK=quarantine"
  [[ -n "${UTC_GUARDRAIL_ENDPOINT:-}" ]] && echo "UTC_GUARDRAIL_ENDPOINT=$UTC_GUARDRAIL_ENDPOINT"
  [[ -n "${UTC_GUARDRAIL_MODEL:-}" ]] && echo "UTC_GUARDRAIL_MODEL=$UTC_GUARDRAIL_MODEL"
  [[ -n "${UTC_GUARDRAIL_API_KEY:-}" ]] && echo "UTC_GUARDRAIL_API_KEY=$UTC_GUARDRAIL_API_KEY"
  [[ -n "${UTC_SCANNER_ENDPOINT:-}" ]] && echo "UTC_SCANNER_ENDPOINT=$UTC_SCANNER_ENDPOINT"
  [[ -n "${UTC_SCANNER_MODEL:-}" ]] && echo "UTC_SCANNER_MODEL=$UTC_SCANNER_MODEL"
  [[ -n "${UTC_SCANNER_API_KEY:-}" ]] && echo "UTC_SCANNER_API_KEY=$UTC_SCANNER_API_KEY"
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
sudo systemctl enable --now untrusted-content.service

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
