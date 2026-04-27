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

instance_primary_ip() {
  local name="$1"
  limactl shell "$name" -- bash -s <<'REMOTE' | tr -d '\r'
set -euo pipefail
ip route get 1.1.1.1 2>/dev/null |
  awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
REMOTE
}

instance_default_gateway() {
  local name="$1"
  limactl shell "$name" -- bash -s <<'REMOTE' | tr -d '\r'
set -euo pipefail
ip route show default | awk '{ print $3; exit }'
REMOTE
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
  local listen="${3:-127.0.0.1:8888}"
  local proxy_url="${4:-http://127.0.0.1:8888}"
  local installer="$ROOT_DIR/scripts/dev/lima/install-pipelock-in-guest.sh"
  [[ -f "$installer" ]] || die "Pipelock installer not found at $installer"

  log "installing Pipelock egress proxy in $name"
  limactl shell "$name" -- sudo env \
    "PIPELOCK_PROFILE=$profile" \
    "PIPELOCK_LISTEN=$listen" \
    "PIPELOCK_HEALTH_ADDR=127.0.0.1:8888" \
    "PIPELOCK_PROXY_URL=$proxy_url" \
    bash -s <"$installer"
}

configure_gateway_egress_route() {
  log "preferring gateway slirp egress for Pipelock upstream traffic"
  limactl shell openclaw-gateway -- sudo bash -s <<'REMOTE'
set -euo pipefail
slirp_gateway="$(ip route show default dev eth0 | awk '{ print $3; exit }')"
if [[ -n "$slirp_gateway" ]]; then
  ip route replace default via "$slirp_gateway" dev eth0 metric 50 || true
fi
REMOTE
}

configure_untrusted_proxy_client() {
  local gateway_ip="$1"
  local proxy_port="$2"
  local proxy_url="http://$gateway_ip:$proxy_port"

  log "configuring untrusted guest proxy client for gateway Pipelock at $proxy_url"
  limactl shell openclaw-untrusted -- sudo env \
    "OPENCLAW_GATEWAY_IP=$gateway_ip" \
    "OPENCLAW_PROXY_URL=$proxy_url" \
    bash -s <<'REMOTE'
set -euo pipefail

systemctl disable --now pipelock.service >/dev/null 2>&1 || true

tmp_hosts="$(mktemp)"
grep -Ev '(^|[[:space:]])(lima-openclaw-gateway\.internal|openclaw-gateway\.internal)([[:space:]]|$)' /etc/hosts >"$tmp_hosts" || true
printf '%s lima-openclaw-gateway.internal openclaw-gateway.internal\n' "$OPENCLAW_GATEWAY_IP" >>"$tmp_hosts"
install -m 0644 "$tmp_hosts" /etc/hosts
rm -f "$tmp_hosts"

cat >/etc/apt/apt.conf.d/95openclaw-pipelock-proxy <<APT
Acquire::http::Proxy "$OPENCLAW_PROXY_URL";
Acquire::https::Proxy "$OPENCLAW_PROXY_URL";
Acquire::http::No-Proxy "localhost,127.0.0.1";
Acquire::https::No-Proxy "localhost,127.0.0.1";
APT

cat >/etc/profile.d/openclaw-pipelock-proxy.sh <<PROFILE
# OpenClaw untrusted Lima guests route ordinary external HTTP(S) through
# the trusted gateway's Pipelock proxy. The host PF anchor is the security
# boundary; this file is client convenience.
export http_proxy="$OPENCLAW_PROXY_URL"
export https_proxy="$OPENCLAW_PROXY_URL"
export HTTP_PROXY="$OPENCLAW_PROXY_URL"
export HTTPS_PROXY="$OPENCLAW_PROXY_URL"
export no_proxy="localhost,127.0.0.1,127.0.0.0/8,::1"
export NO_PROXY="localhost,127.0.0.1,127.0.0.0/8,::1"
PROFILE

cat >/etc/pip.conf <<PIP
[global]
proxy = $OPENCLAW_PROXY_URL
PIP

if command -v git >/dev/null 2>&1; then
  git config --system http.proxy "$OPENCLAW_PROXY_URL"
  git config --system https.proxy "$OPENCLAW_PROXY_URL"
fi
if command -v npm >/dev/null 2>&1; then
  npm config set --location=global proxy "$OPENCLAW_PROXY_URL" >/dev/null
  npm config set --location=global https-proxy "$OPENCLAW_PROXY_URL" >/dev/null
fi

mkdir -p /usr/local/sbin
cat >/usr/local/sbin/openclaw-untrusted-route-guard <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

egress_dev="$(ip route get 1.1.1.1 2>/dev/null |
  awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
egress_gateway="$(ip route show default ${egress_dev:+dev "$egress_dev"} |
  awk '{ print $3; exit }')"

if [[ -n "$egress_dev" && -n "$egress_gateway" ]]; then
  ip route replace default via "$egress_gateway" dev "$egress_dev" metric 50 || true
fi

while read -r _ _ route_gateway _ route_dev _; do
  if [[ -n "${route_dev:-}" && "$route_dev" != "$egress_dev" ]]; then
    ip route del default via "$route_gateway" dev "$route_dev" 2>/dev/null || true
  fi
done < <(ip route show default)

if command -v iptables >/dev/null 2>&1; then
  chain="OC_UNTRUSTED_ROUTE"
  iptables -w -N "$chain" 2>/dev/null || true
  iptables -w -F "$chain"
  iptables -w -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -w -A "$chain" -o lo -j RETURN
  if [[ -n "$egress_dev" ]]; then
    iptables -w -A "$chain" -o "$egress_dev" -j RETURN
  fi
  iptables -w -A "$chain" -j REJECT --reject-with icmp-host-prohibited
  iptables -w -C OUTPUT -j "$chain" 2>/dev/null ||
    iptables -w -I OUTPUT 1 -j "$chain"
fi

sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true
SCRIPT
chmod 0755 /usr/local/sbin/openclaw-untrusted-route-guard

cat >/etc/systemd/system/openclaw-untrusted-route-guard.service <<'SERVICE'
[Unit]
Description=OpenClaw untrusted VM route guard
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/openclaw-untrusted-route-guard
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable openclaw-untrusted-route-guard.service >/dev/null
systemctl restart openclaw-untrusted-route-guard.service
REMOTE
}

configure_host_egress_pf() {
  local script="$ROOT_DIR/scripts/dev/lima/configure-host-egress-pf.sh"
  [[ -f "$script" ]] || die "host PF script not found at $script"
  log "installing host-enforced untrusted egress PF anchor"
  OPENCLAW_PIPELOCK_PORT="${OPENCLAW_PIPELOCK_PORT:-8888}" bash "$script"
}

ensure_agent_workspace_roots() {
  log "creating gateway and untrusted workspace roots"
  limactl shell openclaw-gateway -- bash -lc '
    set -euo pipefail
    mkdir -p "$HOME/.openclaw/workspace/untrusted-read" "$HOME/.openclaw/workspace/untrusted-write"
  '
  limactl shell openclaw-untrusted -- bash -lc '
    set -euo pipefail
    mkdir -p /tmp/openclaw-sandboxes
    chmod 700 /tmp/openclaw-sandboxes
  '
}

main() {
  command -v limactl >/dev/null 2>&1 || die "limactl is required"
  require_running_instance openclaw-gateway
  require_running_instance openclaw-untrusted

  local gateway_ip untrusted_ip host_gateway proxy_port
  proxy_port="${OPENCLAW_PIPELOCK_PORT:-8888}"
  [[ "$proxy_port" =~ ^[0-9]+$ ]] || die "OPENCLAW_PIPELOCK_PORT must be numeric"
  gateway_ip="$(instance_primary_ip openclaw-gateway)"
  untrusted_ip="$(instance_primary_ip openclaw-untrusted)"
  host_gateway="$(instance_default_gateway openclaw-untrusted)"
  [[ -n "$gateway_ip" ]] ||
    die "failed to resolve openclaw-gateway primary egress IP; strict host egress needs a visible VZ NAT IP"
  [[ -n "$untrusted_ip" ]] ||
    die "failed to resolve openclaw-untrusted primary egress IP; strict host egress needs a visible VZ NAT IP"
  [[ "$gateway_ip" != "$untrusted_ip" ]] ||
    die "openclaw-gateway and openclaw-untrusted resolved the same IP ($gateway_ip); strict egress requires distinct VZ NAT addresses"
  [[ -n "$host_gateway" ]] || die "failed to resolve untrusted VM default gateway"

  local untrusted_user
  untrusted_user="$(limactl shell openclaw-untrusted -- whoami | tr -d '\r\n')"
  [[ -n "$untrusted_user" ]] || die "failed to resolve untrusted guest user"

  configure_gateway_egress_route
  install_pipelock_on_instance openclaw-gateway gateway "0.0.0.0:$proxy_port" "http://127.0.0.1:$proxy_port"
  clear_legacy_untrusted_egress_guard
  configure_untrusted_proxy_client "$host_gateway" "$proxy_port"
  ensure_agent_workspace_roots

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

  local port target
  port="$(ssh_local_port openclaw-untrusted)"
  [[ "$port" =~ ^[0-9]+$ ]] || die "failed to resolve openclaw-untrusted SSH local port"
  target="${untrusted_user}@host.lima.internal:${port}"
  log "recording untrusted SSH host key"
  limactl shell openclaw-gateway -- bash -lc \
    "set -euo pipefail; mkdir -p \"\$HOME/.ssh\"; chmod 700 \"\$HOME/.ssh\"; ssh-keyscan -p '$port' host.lima.internal >\"\$HOME/.ssh/openclaw_untrusted_known_hosts.tmp\" 2>/dev/null; mv \"\$HOME/.ssh/openclaw_untrusted_known_hosts.tmp\" \"\$HOME/.ssh/openclaw_untrusted_known_hosts\"; chmod 644 \"\$HOME/.ssh/openclaw_untrusted_known_hosts\""

  log "testing gateway -> untrusted SSH target $target"
  limactl shell openclaw-gateway -- bash -lc \
    "ssh -i \"\$HOME/.ssh/openclaw_untrusted_ed25519\" -p '$port' -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"\$HOME/.ssh/openclaw_untrusted_known_hosts\" '${untrusted_user}@host.lima.internal' 'printf ok' >/dev/null"

  configure_host_egress_pf

  log "testing untrusted -> gateway Pipelock proxy path"
  limactl shell openclaw-untrusted -- bash -lc \
    "timeout 20 curl -fsS --proxy 'http://$host_gateway:$proxy_port' https://api.github.com/zen >/dev/null"

  log "re-testing gateway -> untrusted SSH after host PF enforcement"
  limactl shell openclaw-gateway -- bash -lc \
    "ssh -i \"\$HOME/.ssh/openclaw_untrusted_ed25519\" -p '$port' -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"\$HOME/.ssh/openclaw_untrusted_known_hosts\" '${untrusted_user}@host.lima.internal' 'printf ok' >/dev/null"

  log "applying gateway OpenClaw config for the untrusted agent"
  limactl shell openclaw-gateway -- bash -lc \
    "OPENCLAW_CLI=\"\$HOME/bin/openclaw\" LOCKSMITH_EGRESS_PROXY=\"http://127.0.0.1:$proxy_port\" OPENCLAW_UNTRUSTED_SSH_TARGET='$target' OPENCLAW_UNTRUSTED_SSH_KNOWN_HOSTS_FILE=\"\$HOME/.ssh/openclaw_untrusted_known_hosts\" bash '$ROOT_DIR/scripts/dev/lima/install-locksmith-in-guest.sh'"

  log "configured untrusted sandbox target: $target"
}

main "$@"
