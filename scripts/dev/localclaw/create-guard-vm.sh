#!/usr/bin/env bash
# Creates/starts the localclaw guard VM under a per-runtime LIMA_HOME and
# installs the untrusted-content service in it. Idempotent: re-running on an
# existing VM starts it and re-runs the in-guest installer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
UTC_REPO_DEFAULT="$WORKSPACE_ROOT/deps/exocortex-untrusted-content"

log() { printf '[create-guard-vm] %s\n' "$*"; }
die() { printf '[create-guard-vm] error: %s\n' "$*" >&2; exit 1; }

NAME="localclaw"
GUARD_PORT="18787"
UTC_REPO="${LOCALCLAW_UTC_REPO:-$UTC_REPO_DEFAULT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --guard-port) GUARD_PORT="$2"; shift 2 ;;
    --utc-repo) UTC_REPO="$2"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

RUNTIME_DIR="$WORKSPACE_ROOT/claw-runtime/$NAME"
VM_NAME="${NAME}-guard"
TEMPLATE="$SCRIPT_DIR/localclaw-guard.yaml"

[[ -f "$UTC_REPO/pyproject.toml" ]] || die "untrusted-content checkout missing at $UTC_REPO"
command -v limactl >/dev/null || die "limactl not found"

mkdir -p "$RUNTIME_DIR/lima" "$RUNTIME_DIR/metadata"
export LIMA_HOME="$RUNTIME_DIR/lima"

MOUNTS_JSON="[{\"location\": \"$UTC_REPO\", \"writable\": false}]"

if limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$VM_NAME"; then
  log "VM $VM_NAME exists; starting"
  limactl start --tty=false "$VM_NAME"
else
  log "creating VM $VM_NAME (guard port host 127.0.0.1:$GUARD_PORT -> guest 8787)"
  limactl start --tty=false --name="$VM_NAME" \
    --set ".mounts = $MOUNTS_JSON" \
    --set ".portForwards[0].hostPort = $GUARD_PORT" \
    "$TEMPLATE"
fi

log "running in-guest installer"
limactl shell "$VM_NAME" -- env \
  "UTC_REPO_MOUNT=$UTC_REPO" \
  "UTC_PORT=8787" \
  "UTC_GUARDRAIL_MODE=${UTC_GUARDRAIL_MODE:-heuristic}" \
  "UTC_SCANNER_MODE=${UTC_SCANNER_MODE:-heuristic}" \
  "UTC_GUARDRAIL_ENDPOINT=${UTC_GUARDRAIL_ENDPOINT:-}" \
  "UTC_GUARDRAIL_MODEL=${UTC_GUARDRAIL_MODEL:-}" \
  "UTC_GUARDRAIL_API_KEY=${UTC_GUARDRAIL_API_KEY:-}" \
  "UTC_SCANNER_ENDPOINT=${UTC_SCANNER_ENDPOINT:-}" \
  "UTC_SCANNER_MODEL=${UTC_SCANNER_MODEL:-}" \
  "UTC_SCANNER_API_KEY=${UTC_SCANNER_API_KEY:-}" \
  bash -s < "$SCRIPT_DIR/install-guard-in-guest.sh"

log "verifying host-side forward"
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${GUARD_PORT}/health" >/dev/null 2>&1; then
    log "guard healthy at http://127.0.0.1:${GUARD_PORT}"
    exit 0
  fi
  sleep 1
done
die "guard not reachable on host 127.0.0.1:${GUARD_PORT}"
