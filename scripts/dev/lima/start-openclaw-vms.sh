#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/claw-runtime-env.sh"

openclaw_prepare_runtime_dirs

start_instance() {
  local name="$1"
  local template="$2"
  shift 2
  if [[ -d "$LIMA_HOME/$name" ]]; then
    limactl start --tty=false "$name"
  else
    limactl start --tty=false --name="$name" "$@" "$template"
  fi
}

printf '[openclaw claw-runtime] starting VM pair\n'
openclaw_runtime_summary

start_instance "$OPENCLAW_GATEWAY_INSTANCE" "$OPENCLAW_REPO_ROOT/scripts/dev/lima/openclaw-gateway.yaml" \
  --set ".portForwards[0].hostPort = $OPENCLAW_GATEWAY_HOST_PORT" \
  --set ".portForwards[1].hostPort = $OPENCLAW_GATEWAY_ALT_HOST_PORT" \
  --set ".portForwards[2].guestPort = $OPENCLAW_PIPELOCK_GUEST_PORT" \
  --set ".portForwards[2].hostPort = $OPENCLAW_PIPELOCK_PORT" \
  --set ".env.OPENCLAW_RUNTIME_NAME = \"$OPENCLAW_RUNTIME_NAME\""

start_instance "$OPENCLAW_UNTRUSTED_INSTANCE" "$OPENCLAW_REPO_ROOT/scripts/dev/lima/openclaw-untrusted.yaml" \
  --set ".portForwards[0].hostPort = $OPENCLAW_UNTRUSTED_HOST_PORT" \
  --set ".portForwards[1].hostPort = $OPENCLAW_UNTRUSTED_ALT_HOST_PORT" \
  --set ".env.OPENCLAW_RUNTIME_NAME = \"$OPENCLAW_RUNTIME_NAME\""

limactl list
