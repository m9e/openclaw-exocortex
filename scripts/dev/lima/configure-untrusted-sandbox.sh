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

clear_legacy_untrusted_egress_guard() {
  log "clearing any legacy untrusted blanket egress guard"
  limactl shell openclaw-untrusted -- sudo bash -s <<'REMOTE'
set -euo pipefail

systemctl stop openclaw-untrusted-egress-guard.service 2>/dev/null || true

if command -v iptables >/dev/null 2>&1; then
  while iptables -w -C OUTPUT -j OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null; do
    iptables -w -D OUTPUT -j OPENCLAW_UNTRUSTED_EGRESS || true
  done
  iptables -w -F OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null || true
  iptables -w -X OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null || true
fi

if command -v ip6tables >/dev/null 2>&1; then
  while ip6tables -w -C OUTPUT -j OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null; do
    ip6tables -w -D OUTPUT -j OPENCLAW_UNTRUSTED_EGRESS || true
  done
  ip6tables -w -F OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null || true
  ip6tables -w -X OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null || true
fi
REMOTE
}

install_pipelock_on_instance() {
  local name="$1"
  local profile="$2"
  local installer="$ROOT_DIR/scripts/dev/lima/install-pipelock-in-guest.sh"
  [[ -f "$installer" ]] || die "Pipelock installer not found at $installer"

  log "installing Pipelock egress proxy in $name"
  limactl shell "$name" -- sudo env \
    "PIPELOCK_PROFILE=$profile" \
    bash -s <"$installer"
}

configure_untrusted_egress_guard() {
  local ports_text="${OPENCLAW_UNTRUSTED_BLOCK_HOST_PORTS:-29789 29790}"
  local allow_direct_internet="${OPENCLAW_UNTRUSTED_ALLOW_DIRECT_INTERNET:-${OPENCLAW_UNTRUSTED_ALLOW_INTERNET:-0}}"
  local port
  for port in $ports_text; do
    [[ "$port" =~ ^[0-9]+$ ]] || die "invalid OPENCLAW_UNTRUSTED_BLOCK_HOST_PORTS entry: $port"
  done
  [[ "$allow_direct_internet" == "0" || "$allow_direct_internet" == "1" ]] ||
    die "OPENCLAW_UNTRUSTED_ALLOW_DIRECT_INTERNET must be 0 or 1"

  log "blocking untrusted guest egress to trusted gateway host ports: $ports_text"
  if [[ "$allow_direct_internet" != "1" ]]; then
    log "forcing untrusted guest external HTTP(S)/DNS through local Pipelock"
  fi
  limactl shell openclaw-untrusted -- sudo env \
    "OPENCLAW_BLOCK_HOST_PORTS=$ports_text" \
    "OPENCLAW_ALLOW_DIRECT_INTERNET=$allow_direct_internet" \
    bash -s <<'REMOTE'
set -euo pipefail

if ! command -v iptables >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables
fi

mkdir -p /usr/local/sbin
cat >/usr/local/sbin/openclaw-untrusted-egress-guard <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

ports_text="${OPENCLAW_BLOCK_HOST_PORTS:-29789 29790}"
pipelock_uid="$(id -u pipelock 2>/dev/null || true)"
if [[ -z "$pipelock_uid" ]]; then
  echo "pipelock user is missing; run install-pipelock-in-guest.sh first" >&2
  exit 1
fi

resolver_uids=()
for resolver_user in systemd-resolve _systemd-resolve; do
  if resolver_uid="$(id -u "$resolver_user" 2>/dev/null)"; then
    resolver_uids+=("$resolver_uid")
  fi
done

host_ip="$(getent ahostsv4 host.lima.internal | awk 'NR == 1 { print $1 }')"
if [[ -z "$host_ip" ]]; then
  echo "failed to resolve host.lima.internal" >&2
  exit 1
fi

iptables -w -N OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null || true
iptables -w -F OPENCLAW_UNTRUSTED_EGRESS
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
  -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

for port in $ports_text; do
  [[ "$port" =~ ^[0-9]+$ ]] || {
    echo "invalid blocked host port: $port" >&2
    exit 1
  }
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -p tcp -d "$host_ip" --dport "$port" \
    -j REJECT --reject-with tcp-reset
done

iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
  -m owner --uid-owner "$pipelock_uid" \
  -p tcp -m multiport --dports 80,443 -j RETURN
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
  -m owner --uid-owner "$pipelock_uid" \
  -p udp --dport 53 -j RETURN
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
  -m owner --uid-owner "$pipelock_uid" \
  -p tcp --dport 53 -j RETURN
for resolver_uid in "${resolver_uids[@]}"; do
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m owner --uid-owner "$resolver_uid" \
    -p udp --dport 53 -j RETURN
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m owner --uid-owner "$resolver_uid" \
    -p tcp --dport 53 -j RETURN
done
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
  -p udp --dport 53 -j REJECT --reject-with icmp-port-unreachable
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
  -p tcp --dport 53 -j REJECT --reject-with tcp-reset

iptables -w -A OPENCLAW_UNTRUSTED_EGRESS -o lo -j RETURN
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS -d 10.0.0.0/8 -j RETURN
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS -d 172.16.0.0/12 -j RETURN
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS -d 192.168.0.0/16 -j RETURN
iptables -w -A OPENCLAW_UNTRUSTED_EGRESS -d 169.254.0.0/16 -j RETURN

if [[ "${OPENCLAW_ALLOW_DIRECT_INTERNET:-0}" != "1" ]]; then
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m limit --limit 5/min -j LOG --log-prefix "openclaw-egress-block: " --log-uid
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -p tcp -j REJECT --reject-with tcp-reset
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -p udp -j REJECT --reject-with icmp-port-unreachable
  iptables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -p icmp -j REJECT --reject-with icmp-host-prohibited
fi

iptables -w -C OUTPUT -j OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null ||
  iptables -w -I OUTPUT 1 -j OPENCLAW_UNTRUSTED_EGRESS

if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -w -N OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null || true
  ip6tables -w -F OPENCLAW_UNTRUSTED_EGRESS
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m owner --uid-owner "$pipelock_uid" \
    -p tcp -m multiport --dports 80,443 -j RETURN
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m owner --uid-owner "$pipelock_uid" \
    -p udp --dport 53 -j RETURN
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
    -m owner --uid-owner "$pipelock_uid" \
    -p tcp --dport 53 -j RETURN
  for resolver_uid in "${resolver_uids[@]}"; do
    ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
      -m owner --uid-owner "$resolver_uid" \
      -p udp --dport 53 -j RETURN
    ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
      -m owner --uid-owner "$resolver_uid" \
      -p tcp --dport 53 -j RETURN
  done
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS -p udp --dport 53 -j REJECT
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS -p tcp --dport 53 -j REJECT --reject-with tcp-reset
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS -o lo -j RETURN
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS -d fc00::/7 -j RETURN
  ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS -d fe80::/10 -j RETURN

  if [[ "${OPENCLAW_ALLOW_DIRECT_INTERNET:-0}" != "1" ]]; then
    ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
      -m limit --limit 5/min -j LOG --log-prefix "openclaw-ipv6-egress-block: " --log-uid
    ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
      -p tcp -j REJECT --reject-with tcp-reset
    ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
      -p udp -j REJECT
    ip6tables -w -A OPENCLAW_UNTRUSTED_EGRESS \
      -p ipv6-icmp -j REJECT
  fi
  ip6tables -w -C OUTPUT -j OPENCLAW_UNTRUSTED_EGRESS 2>/dev/null ||
    ip6tables -w -I OUTPUT 1 -j OPENCLAW_UNTRUSTED_EGRESS
fi
SCRIPT
chmod 0755 /usr/local/sbin/openclaw-untrusted-egress-guard

cat >/etc/systemd/system/openclaw-untrusted-egress-guard.service <<SERVICE
[Unit]
Description=OpenClaw untrusted VM egress guard
After=network-online.target pipelock.service
Wants=network-online.target
Requires=pipelock.service

[Service]
Type=oneshot
Environment="OPENCLAW_BLOCK_HOST_PORTS=$OPENCLAW_BLOCK_HOST_PORTS"
Environment="OPENCLAW_ALLOW_DIRECT_INTERNET=$OPENCLAW_ALLOW_DIRECT_INTERNET"
ExecStart=/usr/local/sbin/openclaw-untrusted-egress-guard
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable openclaw-untrusted-egress-guard.service >/dev/null
systemctl restart openclaw-untrusted-egress-guard.service
REMOTE
}

main() {
  command -v limactl >/dev/null 2>&1 || die "limactl is required"
  require_running_instance openclaw-gateway
  require_running_instance openclaw-untrusted

  local untrusted_user
  untrusted_user="$(limactl shell openclaw-untrusted -- whoami | tr -d '\r\n')"
  [[ -n "$untrusted_user" ]] || die "failed to resolve untrusted guest user"

  install_pipelock_on_instance openclaw-gateway gateway
  clear_legacy_untrusted_egress_guard
  install_pipelock_on_instance openclaw-untrusted untrusted

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
  log "recording untrusted SSH host key"
  limactl shell openclaw-gateway -- bash -lc \
    "set -euo pipefail; mkdir -p \"\$HOME/.ssh\"; chmod 700 \"\$HOME/.ssh\"; ssh-keyscan -p '$port' host.lima.internal >\"\$HOME/.ssh/openclaw_untrusted_known_hosts.tmp\" 2>/dev/null; mv \"\$HOME/.ssh/openclaw_untrusted_known_hosts.tmp\" \"\$HOME/.ssh/openclaw_untrusted_known_hosts\"; chmod 644 \"\$HOME/.ssh/openclaw_untrusted_known_hosts\""

  log "testing gateway -> untrusted SSH target $target"
  limactl shell openclaw-gateway -- bash -lc \
    "ssh -i \"\$HOME/.ssh/openclaw_untrusted_ed25519\" -p '$port' -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"\$HOME/.ssh/openclaw_untrusted_known_hosts\" '${untrusted_user}@host.lima.internal' 'printf ok' >/dev/null"

  configure_untrusted_egress_guard

  log "applying gateway OpenClaw config for the untrusted agent"
  limactl shell openclaw-gateway -- bash -lc \
    "OPENCLAW_CLI=\"\$HOME/bin/openclaw\" LOCKSMITH_EGRESS_PROXY=\"http://127.0.0.1:8888\" OPENCLAW_UNTRUSTED_SSH_TARGET='$target' OPENCLAW_UNTRUSTED_SSH_KNOWN_HOSTS_FILE=\"\$HOME/.ssh/openclaw_untrusted_known_hosts\" bash '$ROOT_DIR/scripts/dev/lima/install-locksmith-in-guest.sh'"

  log "configured untrusted sandbox target: $target"
}

main "$@"
