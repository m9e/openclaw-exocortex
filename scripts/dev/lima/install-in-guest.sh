#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[openclaw guest install] %s\n' "$*"
}

die() {
  printf '[openclaw guest install] error: %s\n' "$*" >&2
  exit 1
}

run_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root"
  sudo "$@"
}

version_ge() {
  local actual="$1"
  local required="$2"
  [[ "$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n 1)" == "$required" ]]
}

node_version_satisfies() {
  command -v node >/dev/null 2>&1 || return 1
  local version
  version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "$version" ]] || return 1
  version_ge "$version" "24.0.0"
}

resolve_pnpm_version() {
  local package_json="$1"
  node -e '
    const pkg = require(process.argv[1]);
    const packageManager = String(pkg.packageManager || "");
    const match = /^pnpm@(.+)$/.exec(packageManager);
    process.stdout.write(match?.[1] || "10.32.1");
  ' "$package_json"
}

assert_guest_context() {
  [[ "$(uname -s)" == "Linux" ]] || die "run this inside the Lima Linux guest"
  if [[ "${OPENCLAW_VM_ROLE:-}" != "gateway" ]]; then
    log "OPENCLAW_VM_ROLE is ${OPENCLAW_VM_ROLE:-unset}; continuing anyway"
  fi
}

install_system_packages() {
  command -v apt-get >/dev/null 2>&1 || die "this installer currently expects an apt-based guest"

  log "installing system packages"
  run_sudo apt-get update
  run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    libpam0g-dev \
    openssl \
    pkg-config \
    python3
}

install_node() {
  if node_version_satisfies; then
    log "Node $(node -v) is already installed"
    return
  fi

  log "installing Node 24 from NodeSource"
  if [[ "$(id -u)" -eq 0 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  else
    command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root"
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  fi
  run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

install_pnpm() {
  local source_repo="$1"
  local pnpm_version="${OPENCLAW_GUEST_PNPM_VERSION:-}"
  if [[ -z "$pnpm_version" ]]; then
    pnpm_version="$(resolve_pnpm_version "$source_repo/package.json")"
  fi

  log "activating pnpm $pnpm_version"
  run_sudo corepack enable
  corepack prepare "pnpm@$pnpm_version" --activate
}

sync_checkout() {
  local source_repo="$1"
  local install_dir="$2"

  mkdir -p "$(dirname "$install_dir")"
  if [[ -d "$install_dir/.git" ]]; then
    if [[ -n "$(git -C "$install_dir" status --porcelain)" && "${OPENCLAW_GUEST_FORCE:-}" != "1" ]]; then
      die "$install_dir has local changes; set OPENCLAW_GUEST_FORCE=1 to discard them"
    fi
    log "refreshing existing checkout at $install_dir"
    git -C "$install_dir" fetch --tags "$source_repo" HEAD
    git -C "$install_dir" reset --hard FETCH_HEAD
    return
  fi

  [[ ! -e "$install_dir" ]] || die "$install_dir exists but is not a git checkout"
  log "cloning mounted source repo into $install_dir"
  git clone --no-local "$source_repo" "$install_dir"
}

install_workspace_deps() {
  local install_dir="$1"
  log "installing workspace dependencies"
  cd "$install_dir"
  pnpm install
}

ensure_gateway_token() {
  local state_dir="$HOME/.openclaw"
  local token_file="$state_dir/gateway.token"
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"

  if [[ ! -s "$token_file" ]]; then
    log "creating $token_file"
    openssl rand -hex 32 >"$token_file"
  fi
  chmod 600 "$token_file"
}

write_cli_helper() {
  local install_dir="$1"
  local bin_dir="$HOME/bin"
  local helper="$bin_dir/openclaw"

  mkdir -p "$bin_dir"
  cat >"$helper" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cd "$install_dir"
exec node scripts/run-node.mjs "\$@"
EOF
  chmod 700 "$helper"
}

write_run_helper() {
  local install_dir="$1"
  local bin_dir="$HOME/bin"
  local helper="$bin_dir/openclaw-gateway-dev"

  mkdir -p "$bin_dir"
  cat >"$helper" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_GATEWAY_TOKEN="\${OPENCLAW_GATEWAY_TOKEN:-\$(cat "\$HOME/.openclaw/gateway.token")}"
export OPENCLAW_REQUIRE_LOCKSMITH="\${OPENCLAW_REQUIRE_LOCKSMITH:-1}"
extra_args=()
if [[ "\${OPENCLAW_GATEWAY_REQUIRE_CONFIG:-}" != "1" ]]; then
  extra_args+=(--allow-unconfigured)
fi
exec "\$HOME/bin/openclaw" gateway --port "\${OPENCLAW_GATEWAY_PORT:-18789}" --verbose "\${extra_args[@]}" "\$@"
EOF
  chmod 700 "$helper"
}

ensure_user_bin_on_path() {
  local profile="$HOME/.profile"

  if [[ -f "$profile" ]] && grep -qs "OPENCLAW_GUEST_BIN" "$profile"; then
    return
  fi

  cat >>"$profile" <<'EOF'

# OPENCLAW_GUEST_BIN: local OpenClaw dev helpers
case ":$PATH:" in
  *":$HOME/bin:"*) ;;
  *) PATH="$HOME/bin:$PATH" ;;
esac
export PATH
EOF
}

install_locksmith() {
  local install_dir="$1"
  if [[ "${OPENCLAW_GUEST_INSTALL_LOCKSMITH:-1}" == "0" ]]; then
    log "skipping Locksmith install (OPENCLAW_GUEST_INSTALL_LOCKSMITH=0)"
    return
  fi

  local installer="$install_dir/scripts/dev/lima/install-locksmith-in-guest.sh"
  [[ -f "$installer" ]] || die "Locksmith installer not found at $installer"

  log "installing required Locksmith sidecar"
  OPENCLAW_CLI="$HOME/bin/openclaw" bash "$installer"
}

install_pipelock() {
  local install_dir="$1"
  if [[ "${OPENCLAW_GUEST_INSTALL_PIPELOCK:-1}" == "0" ]]; then
    log "skipping Pipelock install (OPENCLAW_GUEST_INSTALL_PIPELOCK=0)"
    return
  fi

  local installer="$install_dir/scripts/dev/lima/install-pipelock-in-guest.sh"
  [[ -f "$installer" ]] || die "Pipelock installer not found at $installer"

  log "installing required Pipelock egress proxy"
  PIPELOCK_PROFILE="${PIPELOCK_PROFILE:-gateway}" \
    PIPELOCK_LISTEN="${PIPELOCK_LISTEN:-0.0.0.0:8888}" \
    PIPELOCK_HEALTH_ADDR="${PIPELOCK_HEALTH_ADDR:-127.0.0.1:8888}" \
    PIPELOCK_PROXY_URL="${PIPELOCK_PROXY_URL:-http://127.0.0.1:8888}" \
    bash "$installer"
}

main() {
  assert_guest_context

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local default_source_repo
  default_source_repo="$(cd "$script_dir/../../.." && pwd)"

  local source_repo="${OPENCLAW_GUEST_SOURCE_REPO:-$default_source_repo}"
  local install_parent="${OPENCLAW_GUEST_INSTALL_PARENT:-$HOME/code}"
  local install_dir="${OPENCLAW_GUEST_INSTALL_DIR:-$install_parent/openclaw-exocortex}"

  [[ -d "$source_repo/.git" ]] || die "source repo not found at $source_repo"
  [[ "$source_repo" != "$install_dir" ]] || die "install dir must differ from mounted source repo"

  install_system_packages
  install_node
  install_pnpm "$source_repo"
  sync_checkout "$source_repo" "$install_dir"
  install_workspace_deps "$install_dir"
  ensure_gateway_token
  write_cli_helper "$install_dir"
  write_run_helper "$install_dir"
  ensure_user_bin_on_path
  install_pipelock "$install_dir"
  install_locksmith "$install_dir"

  log "installed checkout: $install_dir"
  log "gateway token: $HOME/.openclaw/gateway.token"
  log "CLI helper: $HOME/bin/openclaw"
  log "start gateway inside the guest with: $HOME/bin/openclaw-gateway-dev"
  log "new guest shells can run OpenClaw CLI commands as: openclaw <command>"
  log "from the Mac host, reach it at: http://127.0.0.1:29789/"
}

main "$@"
