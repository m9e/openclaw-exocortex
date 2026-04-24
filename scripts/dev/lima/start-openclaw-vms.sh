#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

start_instance() {
  local name="$1"
  local template="$2"
  if [[ -d "$HOME/.lima/$name" ]]; then
    limactl start --tty=false "$name"
  else
    limactl start --tty=false "$template"
  fi
}

start_instance "openclaw-gateway" "$ROOT_DIR/scripts/dev/lima/openclaw-gateway.yaml"
start_instance "openclaw-untrusted" "$ROOT_DIR/scripts/dev/lima/openclaw-untrusted.yaml"

limactl list
