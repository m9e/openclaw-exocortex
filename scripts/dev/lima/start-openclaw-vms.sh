#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/claw-runtime-env.sh"

openclaw_prepare_runtime_dirs

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

GATEWAY_MOUNTS_JSON=""

# The gateway template ships with no mounts so the host home is never
# readable from the agent VM. Build the explicit narrow set here: repo and
# deps for the guest installers, runtime metadata for credential sync, the
# agent workspace writable, plus operator extras (src[:dst][:rw], comma
# separated, relative dst resolved under the agent workspace).
build_gateway_mounts() {
  local state_dir="${OPENCLAW_AGENT_STATE_HOST_DIR:-}"
  if [[ -n "$state_dir" ]]; then
    state_dir="$(absolute_host_path "$state_dir")"
    mkdir -p "$state_dir"
    export OPENCLAW_AGENT_STATE_HOST_DIR="$state_dir"
    printf '[openclaw claw-runtime] gateway-only writable workspace mount: %s\n' "$state_dir"
    printf '[openclaw claw-runtime] untrusted VM keeps no host mounts\n'
  fi

  GATEWAY_MOUNTS_JSON="$(
    OPENCLAW_MOUNT_REPO="$OPENCLAW_REPO_ROOT" \
      OPENCLAW_MOUNT_DEPS="$OPENCLAW_WORKSPACE_ROOT/deps" \
      OPENCLAW_MOUNT_METADATA="$OPENCLAW_RUNTIME_DIR/metadata" \
      OPENCLAW_MOUNT_WORKSPACE="$state_dir" \
      OPENCLAW_MOUNT_EXTRA="${OPENCLAW_GATEWAY_EXTRA_MOUNTS:-}" \
      node -e '
        const mounts = [
          { location: process.env.OPENCLAW_MOUNT_REPO, writable: false },
          { location: process.env.OPENCLAW_MOUNT_DEPS, writable: false },
          { location: process.env.OPENCLAW_MOUNT_METADATA, writable: false },
        ];
        const workspace = (process.env.OPENCLAW_MOUNT_WORKSPACE || "").trim();
        if (workspace) {
          mounts.push({ location: workspace, writable: true });
        }
        for (const raw of (process.env.OPENCLAW_MOUNT_EXTRA || "").split(",")) {
          const spec = raw.trim();
          if (!spec) continue;
          const parts = spec.split(":");
          const location = parts[0];
          let mountPoint;
          let writable = false;
          for (const part of parts.slice(1)) {
            if (part === "rw" || part === "w") writable = true;
            else if (part === "ro" || part === "") continue;
            else mountPoint = part;
          }
          if (!location || !location.startsWith("/")) {
            console.error(`invalid extra mount spec (absolute src required): ${spec}`);
            process.exit(1);
          }
          if (mountPoint && !mountPoint.startsWith("/")) {
            if (!workspace) {
              console.error(`relative mount dst needs an agent workspace: ${spec}`);
              process.exit(1);
            }
            mountPoint = `${workspace}/${mountPoint}`;
          }
          mounts.push({ location, ...(mountPoint ? { mountPoint } : {}), writable });
        }
        process.stdout.write(JSON.stringify(mounts));
      '
  )"
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
build_gateway_mounts

start_instance "$OPENCLAW_GATEWAY_INSTANCE" "$OPENCLAW_REPO_ROOT/scripts/dev/lima/openclaw-gateway.yaml" \
  --set ".mounts = $GATEWAY_MOUNTS_JSON" \
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
