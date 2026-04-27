#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

log() {
  printf '[openclaw untrusted sandbox] %s\n' "$*"
}

die() {
  printf '[openclaw untrusted sandbox] error: %s\n' "$*" >&2
  exit 1
}

instance_status() {
  local name="$1"
  limactl list --format '{{.Name}} {{.Status}}' | awk -v name="$name" '$1 == name { print $2 }'
}

ssh_local_port() {
  local name="$1"
  limactl list --format '{{.Name}} {{.SSHLocalPort}}' | awk -v name="$name" '$1 == name { print $2 }'
}

require_running_instance() {
  local name="$1"
  local status
  status="$(instance_status "$name")"
  [[ "$status" == "Running" ]] || die "$name is not running (status: ${status:-missing})"
}

append_authorized_key() {
  local pubkey="$1"
  limactl shell openclaw-untrusted -- bash -s -- "$pubkey" <<'REMOTE'
set -euo pipefail
pubkey="$1"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if ! grep -qxF "$pubkey" "$HOME/.ssh/authorized_keys"; then
  printf '%s\n' "$pubkey" >>"$HOME/.ssh/authorized_keys"
fi
REMOTE
}

main() {
  command -v limactl >/dev/null 2>&1 || die "limactl is required"
  require_running_instance openclaw-gateway
  require_running_instance openclaw-untrusted

  local untrusted_user
  untrusted_user="$(limactl shell openclaw-untrusted -- whoami | tr -d '\r\n')"
  [[ -n "$untrusted_user" ]] || die "failed to resolve untrusted guest user"

  log "ensuring SSH server is active in openclaw-untrusted"
  limactl shell openclaw-untrusted -- bash -lc '
    set -euo pipefail
    if ! command -v sshd >/dev/null 2>&1; then
      sudo apt-get update
      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server tar
    fi
    sudo systemctl enable --now ssh >/dev/null
  '

  log "creating gateway SSH identity"
  limactl shell openclaw-gateway -- bash -lc '
    set -euo pipefail
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    if [[ ! -f "$HOME/.ssh/openclaw_untrusted_ed25519" ]]; then
      ssh-keygen -t ed25519 -N "" -C "openclaw-untrusted-sandbox" -f "$HOME/.ssh/openclaw_untrusted_ed25519" >/dev/null
    fi
    chmod 600 "$HOME/.ssh/openclaw_untrusted_ed25519"
    chmod 644 "$HOME/.ssh/openclaw_untrusted_ed25519.pub"
  '

  local pubkey
  pubkey="$(limactl shell openclaw-gateway -- bash -lc 'cat "$HOME/.ssh/openclaw_untrusted_ed25519.pub"' | tr -d '\r')"
  [[ -n "$pubkey" ]] || die "failed to read gateway SSH public key"
  append_authorized_key "$pubkey"

  local port
  port="$(ssh_local_port openclaw-untrusted)"
  [[ "$port" =~ ^[0-9]+$ ]] || die "failed to resolve openclaw-untrusted SSH local port"

  local target="${untrusted_user}@host.lima.internal:${port}"
  log "testing gateway -> untrusted SSH target $target"
  limactl shell openclaw-gateway -- bash -lc \
    "ssh -i \"\$HOME/.ssh/openclaw_untrusted_ed25519\" -p '$port' -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '${untrusted_user}@host.lima.internal' 'printf ok' >/dev/null"

  log "applying gateway OpenClaw config for the untrusted agent"
  limactl shell openclaw-gateway -- bash -lc \
    "OPENCLAW_CLI=\"\$HOME/bin/openclaw\" OPENCLAW_UNTRUSTED_SSH_TARGET='$target' bash '$ROOT_DIR/scripts/dev/lima/install-locksmith-in-guest.sh'"

  log "configured untrusted sandbox target: $target"
}

main "$@"
