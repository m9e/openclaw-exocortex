#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
DEFAULT_REPO="$WORKSPACE_ROOT/deps/exocortex-agent-locksmith"
LOCKSMITH_REPO="${LOCKSMITH_REPO:-$DEFAULT_REPO}"
LOCKSMITH_CONFIG_PATH="${LOCKSMITH_CONFIG_PATH:-$ROOT_DIR/extensions/locksmith/examples/local.locksmith.yaml}"

if [[ ! -f "$LOCKSMITH_REPO/Cargo.toml" ]]; then
  echo "Missing agent-locksmith checkout: $LOCKSMITH_REPO" >&2
  echo "Set LOCKSMITH_REPO=/abs/path/to/exocortex-agent-locksmith or clone the dep repo into $WORKSPACE_ROOT/deps." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build agent-locksmith" >&2
  exit 1
fi

echo "[locksmith] building $LOCKSMITH_REPO"
cargo build --release --manifest-path "$LOCKSMITH_REPO/Cargo.toml"

echo "[locksmith] starting with config $LOCKSMITH_CONFIG_PATH"
exec "$LOCKSMITH_REPO/target/release/locksmith" --config "$LOCKSMITH_CONFIG_PATH"
