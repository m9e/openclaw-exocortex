#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
DEFAULT_REPO="$WORKSPACE_ROOT/deps/exocortex-untrusted-content"
UTC_REPO="${UNTRUSTED_CONTENT_REPO:-$DEFAULT_REPO}"
UTC_HOST="${UNTRUSTED_CONTENT_HOST:-127.0.0.1}"
UTC_PORT="${UNTRUSTED_CONTENT_PORT:-8787}"

if [[ ! -f "$UTC_REPO/pyproject.toml" ]]; then
  echo "Missing tool-untrusted-content checkout: $UTC_REPO" >&2
  echo "Set UNTRUSTED_CONTENT_REPO=/abs/path/to/exocortex-untrusted-content or clone the dep repo into $WORKSPACE_ROOT/deps." >&2
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  echo "[untrusted-content] starting via uv from $UTC_REPO on $UTC_HOST:$UTC_PORT"
  exec uv run --project "$UTC_REPO" untrusted-content server --host "$UTC_HOST" --port "$UTC_PORT"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to run tool-untrusted-content" >&2
  exit 1
fi

echo "[untrusted-content] starting via python3 from $UTC_REPO on $UTC_HOST:$UTC_PORT"
cd "$UTC_REPO"
export PYTHONPATH="$UTC_REPO/src${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m untrusted_content_tool.cli server --host "$UTC_HOST" --port "$UTC_PORT"
