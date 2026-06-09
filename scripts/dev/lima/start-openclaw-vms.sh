#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/claw-runtime-env.sh"

openclaw_prepare_runtime_dirs

GATEWAY_MOUNT_ARGS=()
GATEWAY_MOUNT_ARGS_SET=0

absolute_host_path() {
  local value="$1"
  if [[ "$value" == "~" || "$value" == "~/"* ]]; then
    value="$HOME${value:1}"
  fi
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi
  printf '%s/%s\n' "$PWD" "$value"
}

configure_gateway_agent_state_mount() {
  local state_dir="${OPENCLAW_AGENT_STATE_HOST_DIR:-}"
  if [[ -z "$state_dir" ]]; then
    return
  fi

  state_dir="$(absolute_host_path "$state_dir")"
  mkdir -p "$state_dir"
  export OPENCLAW_AGENT_STATE_HOST_DIR="$state_dir"

  printf '[openclaw claw-runtime] gateway-only writable Lima mount: %s\n' "$state_dir"
  printf '[openclaw claw-runtime] untrusted VM keeps no writable host workspace mount\n'

  if [[ -d "$LIMA_HOME/$OPENCLAW_GATEWAY_INSTANCE" ]]; then
    printf '[openclaw claw-runtime] warning: %s already exists; Lima mount changes only apply at instance creation\n' "$OPENCLAW_GATEWAY_INSTANCE" >&2
    return
  fi

  GATEWAY_MOUNT_ARGS=(
    --mount-only "$OPENCLAW_WORKSPACE_ROOT"
    --mount-only "$state_dir:w"
  )
  GATEWAY_MOUNT_ARGS_SET=1
}

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
openclaw_validate_lima_socket_paths
configure_gateway_agent_state_mount

if [[ "$GATEWAY_MOUNT_ARGS_SET" == "1" ]]; then
  start_instance "$OPENCLAW_GATEWAY_INSTANCE" "$OPENCLAW_REPO_ROOT/scripts/dev/lima/openclaw-gateway.yaml" \
    "${GATEWAY_MOUNT_ARGS[@]}" \
    --set ".portForwards[0].hostPort = $OPENCLAW_GATEWAY_HOST_PORT" \
    --set ".portForwards[1].hostPort = $OPENCLAW_GATEWAY_ALT_HOST_PORT" \
    --set ".portForwards[2].guestPort = $OPENCLAW_PIPELOCK_GUEST_PORT" \
    --set ".portForwards[2].hostPort = $OPENCLAW_PIPELOCK_PORT" \
    --set ".env.OPENCLAW_RUNTIME_NAME = \"$OPENCLAW_RUNTIME_NAME\""
else
  start_instance "$OPENCLAW_GATEWAY_INSTANCE" "$OPENCLAW_REPO_ROOT/scripts/dev/lima/openclaw-gateway.yaml" \
    --set ".portForwards[0].hostPort = $OPENCLAW_GATEWAY_HOST_PORT" \
    --set ".portForwards[1].hostPort = $OPENCLAW_GATEWAY_ALT_HOST_PORT" \
    --set ".portForwards[2].guestPort = $OPENCLAW_PIPELOCK_GUEST_PORT" \
    --set ".portForwards[2].hostPort = $OPENCLAW_PIPELOCK_PORT" \
    --set ".env.OPENCLAW_RUNTIME_NAME = \"$OPENCLAW_RUNTIME_NAME\""
fi

start_instance "$OPENCLAW_UNTRUSTED_INSTANCE" "$OPENCLAW_REPO_ROOT/scripts/dev/lima/openclaw-untrusted.yaml" \
  --set ".portForwards[0].hostPort = $OPENCLAW_UNTRUSTED_HOST_PORT" \
  --set ".portForwards[1].hostPort = $OPENCLAW_UNTRUSTED_ALT_HOST_PORT" \
  --set ".env.OPENCLAW_RUNTIME_NAME = \"$OPENCLAW_RUNTIME_NAME\""

limactl list
