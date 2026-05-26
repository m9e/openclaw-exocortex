#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/claw-runtime-env.sh"

INSTANCE="${OPENCLAW_GATEWAY_LIMA_INSTANCE:-$OPENCLAW_GATEWAY_INSTANCE}"
HOST_PORT="$OPENCLAW_GATEWAY_HOST_PORT"
URL="${OPENCLAW_GATEWAY_DASHBOARD_URL:-http://127.0.0.1:${HOST_PORT}/}"

token="$(
  limactl shell "$INSTANCE" -- bash -lc 'cat "$HOME/.openclaw/gateway.token"'
)"

printf 'Dashboard URL: %s\n' "$URL"
printf 'Gateway URL: ws://127.0.0.1:%s\n' "$HOST_PORT"
printf 'Token: %s\n' "$token"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$token" | pbcopy
  printf 'Copied token to clipboard.\n'
fi

if command -v open >/dev/null 2>&1; then
  open "$URL"
fi
