#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[openclaw pipelock guest install] %s\n' "$*"
}

die() {
  printf '[openclaw pipelock guest install] error: %s\n' "$*" >&2
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

assert_guest_context() {
  [[ "$(uname -s)" == "Linux" ]] || die "run this inside the Lima Linux guest"
}

resolve_arch() {
  case "$(uname -m)" in
    aarch64 | arm64) printf 'arm64\n' ;;
    x86_64 | amd64) printf 'amd64\n' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

install_host_packages() {
  command -v curl >/dev/null 2>&1 || run_sudo apt-get update
  command -v curl >/dev/null 2>&1 ||
    run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
  command -v tar >/dev/null 2>&1 || run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y tar
}

download_pipelock() {
  local arch="$1"
  local version="${PIPELOCK_VERSION:-v2.3.0}"
  local version_no_v="${version#v}"
  local asset="pipelock_${version_no_v}_linux_${arch}.tar.gz"
  local base_url="https://github.com/luckyPipewrench/pipelock/releases/download/$version"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  log "downloading Pipelock $version for linux-$arch"
  curl -fsSLo "$tmpdir/$asset" "$base_url/$asset"
  curl -fsSLo "$tmpdir/checksums.txt" "$base_url/checksums.txt"
  (cd "$tmpdir" && grep -F "  $asset" checksums.txt | sha256sum -c -)
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"
  [[ -x "$tmpdir/pipelock" ]] || die "downloaded archive did not contain executable pipelock"

  run_sudo install -m 0755 "$tmpdir/pipelock" /usr/local/bin/pipelock
  trap - RETURN
  rm -rf "$tmpdir"
}

profile_value() {
  local profile="$1"
  local key="$2"
  case "$profile:$key" in
    gateway:max_response_mb) printf '50\n' ;;
    gateway:max_requests_per_minute) printf '300\n' ;;
    gateway:max_tunnel_seconds) printf '900\n' ;;
    gateway:idle_timeout_seconds) printf '180\n' ;;
    untrusted:max_response_mb) printf '100\n' ;;
    untrusted:max_requests_per_minute) printf '600\n' ;;
    untrusted:max_tunnel_seconds) printf '1800\n' ;;
    untrusted:idle_timeout_seconds) printf '300\n' ;;
    *:max_response_mb) printf '50\n' ;;
    *:max_requests_per_minute) printf '300\n' ;;
    *:max_tunnel_seconds) printf '900\n' ;;
    *:idle_timeout_seconds) printf '180\n' ;;
    *) return 1 ;;
  esac
}

write_pipelock_config() {
  local profile="${PIPELOCK_PROFILE:-${OPENCLAW_VM_ROLE:-gateway}}"
  local max_response_mb
  local max_requests_per_minute
  local max_tunnel_seconds
  local idle_timeout_seconds
  max_response_mb="$(profile_value "$profile" max_response_mb)"
  max_requests_per_minute="$(profile_value "$profile" max_requests_per_minute)"
  max_tunnel_seconds="$(profile_value "$profile" max_tunnel_seconds)"
  idle_timeout_seconds="$(profile_value "$profile" idle_timeout_seconds)"

  run_sudo groupadd --system pipelock 2>/dev/null || true
  if ! id -u pipelock >/dev/null 2>&1; then
    run_sudo useradd --system --home-dir /var/lib/pipelock --shell /usr/sbin/nologin --gid pipelock pipelock
  fi
  run_sudo install -d -m 0750 -o root -g pipelock /etc/pipelock
  run_sudo install -d -m 0750 -o pipelock -g pipelock /var/lib/pipelock /var/log/pipelock

  local tmp_config
  tmp_config="$(mktemp)"
  cat >"$tmp_config" <<YAML
version: 1
mode: balanced
enforce: true
explain_blocks: false

api_allowlist:
  - "*.anthropic.com"
  - "*.openai.com"
  - "*.google.com"
  - "*.googleapis.com"
  - "*.azure.com"
  - "*.microsoft.com"
  - "api.telegram.org"
  - "*.discord.com"
  - "gateway.discord.gg"
  - "*.slack.com"
  - "github.com"
  - "*.github.com"
  - "*.githubusercontent.com"
  - "*.gitlab.com"
  - "*.bitbucket.org"
  - "registry.npmjs.org"
  - "*.npmjs.com"
  - "pypi.org"
  - "*.python.org"
  - "*.pythonhosted.org"
  - "files.pythonhosted.org"
  - "pkg.go.dev"
  - "proxy.golang.org"
  - "sum.golang.org"
  - "crates.io"
  - "*.crates.io"
  - "*.docs.rs"
  - "*.rubygems.org"
  - "*.maven.org"
  - "*.nuget.org"
  - "*.stackoverflow.com"
  - "*.stackexchange.com"
  - "*.readthedocs.io"
  - "*.readthedocs.org"
  - "ports.ubuntu.com"
  - "*.ubuntu.com"
  - "*.debian.org"
  - "*.docker.io"
  - "*.docker.com"
  - "production.cloudflare.docker.com"
  - "ghcr.io"

fetch_proxy:
  listen: "127.0.0.1:8888"
  timeout_seconds: 60
  max_response_mb: $max_response_mb
  user_agent: "Pipelock Fetch/1.0"
  monitoring:
    max_url_length: 4096
    entropy_threshold: 5.5
    subdomain_entropy_threshold: 4.0
    max_requests_per_minute: $max_requests_per_minute
    blocklist:
      - "pastebin.com"
      - "*.pastebin.com"
      - "hastebin.com"
      - "*.hastebin.com"
      - "paste.ee"
      - "*.paste.ee"
      - "transfer.sh"
      - "*.transfer.sh"
      - "file.io"
      - "*.file.io"
      - "requestbin.com"
      - "*.requestbin.com"
      - "webhook.site"
      - "*.webhook.site"
      - "pipedream.net"
      - "*.pipedream.net"
      - "*.ngrok.io"
      - "*.ngrok-free.app"
    subdomain_entropy_exclusions:
      - "api.telegram.org"
      - "*.githubusercontent.com"

forward_proxy:
  enabled: true
  max_tunnel_seconds: $max_tunnel_seconds
  idle_timeout_seconds: $idle_timeout_seconds
  sni_verification: true

request_body_scanning:
  enabled: true
  action: warn
  max_body_bytes: 5242880
  scan_headers: true
  header_mode: sensitive
  sensitive_headers:
    - "Authorization"
    - "Cookie"
    - "X-Api-Key"
    - "X-Token"
    - "Proxy-Authorization"
    - "X-Goog-Api-Key"

dlp:
  scan_env: false
  include_defaults: true

logging:
  format: json
  output: stdout
  include_allowed: false
  include_blocked: true
YAML

  run_sudo install -m 0640 -o root -g pipelock "$tmp_config" /etc/pipelock/pipelock.yaml
  rm -f "$tmp_config"
}

write_systemd_service() {
  local tmp_service
  tmp_service="$(mktemp)"
  cat >"$tmp_service" <<'UNIT'
[Unit]
Description=Pipelock local egress proxy for OpenClaw
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pipelock
Group=pipelock
ExecStart=/usr/local/bin/pipelock run --config /etc/pipelock/pipelock.yaml
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pipelock /var/log/pipelock

[Install]
WantedBy=multi-user.target
UNIT
  run_sudo install -m 0644 "$tmp_service" /etc/systemd/system/pipelock.service
  rm -f "$tmp_service"
  run_sudo systemctl daemon-reload
  run_sudo systemctl enable pipelock.service >/dev/null
}

write_proxy_environment() {
  local proxy_url="${PIPELOCK_PROXY_URL:-http://127.0.0.1:8888}"
  local no_proxy="localhost,127.0.0.1,127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,host.lima.internal,.local"

  local tmp_apt
  tmp_apt="$(mktemp)"
  cat >"$tmp_apt" <<APT
Acquire::http::Proxy "$proxy_url";
Acquire::https::Proxy "$proxy_url";
Acquire::http::No-Proxy "localhost,127.0.0.1,host.lima.internal";
Acquire::https::No-Proxy "localhost,127.0.0.1,host.lima.internal";
APT
  run_sudo install -m 0644 "$tmp_apt" /etc/apt/apt.conf.d/95openclaw-pipelock-proxy
  rm -f "$tmp_apt"

  local tmp_profile
  tmp_profile="$(mktemp)"
  cat >"$tmp_profile" <<PROFILE
# OpenClaw Lima guests route ordinary external HTTP(S) through local Pipelock.
export http_proxy="$proxy_url"
export https_proxy="$proxy_url"
export HTTP_PROXY="$proxy_url"
export HTTPS_PROXY="$proxy_url"
export no_proxy="$no_proxy"
export NO_PROXY="$no_proxy"
PROFILE
  run_sudo install -m 0644 "$tmp_profile" /etc/profile.d/openclaw-pipelock-proxy.sh
  rm -f "$tmp_profile"

  local tmp_pip
  tmp_pip="$(mktemp)"
  cat >"$tmp_pip" <<PIP
[global]
proxy = $proxy_url
PIP
  run_sudo install -m 0644 "$tmp_pip" /etc/pip.conf
  rm -f "$tmp_pip"

  if command -v git >/dev/null 2>&1; then
    run_sudo git config --system http.proxy "$proxy_url"
    run_sudo git config --system https.proxy "$proxy_url"
  fi
  if command -v npm >/dev/null 2>&1; then
    run_sudo npm config set --location=global proxy "$proxy_url" >/dev/null
    run_sudo npm config set --location=global https-proxy "$proxy_url" >/dev/null
  fi
}

verify_install() {
  log "validating Pipelock config"
  run_sudo /usr/local/bin/pipelock check --config /etc/pipelock/pipelock.yaml >/dev/null
  log "starting Pipelock service"
  run_sudo systemctl restart pipelock.service
  for _ in {1..20}; do
    if /usr/local/bin/pipelock healthcheck --addr 127.0.0.1:8888 >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  run_sudo systemctl status pipelock.service --no-pager -l >&2 || true
  /usr/local/bin/pipelock healthcheck --addr 127.0.0.1:8888
}

main() {
  assert_guest_context
  install_host_packages
  download_pipelock "$(resolve_arch)"
  write_pipelock_config
  write_systemd_service
  write_proxy_environment
  verify_install

  log "installed binary: /usr/local/bin/pipelock"
  log "config: /etc/pipelock/pipelock.yaml"
  log "service: systemctl status pipelock.service"
}

main "$@"
