#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/claw-runtime-env.sh"

DRY_RUN=0
RUN_BOOTSTRAP=1
RUN_EXTENSIONS=1
RUN_EXTENSION_PUSH=1
RUN_EXTENSION_ACTIVATION=1
WAIT_FOR_EXTENSIONS=1
BOOTSTRAP_ARGS=()
EXTENSION_HELPER_ARGS=()
EXTRA_TARGETS=()
TARGET_REPO=""
TARGET_KIND=""
TARGET_NAME=""

log() {
  printf '[openclaw kamiwaza mode] %s\n' "$*"
}

die() {
  printf '[openclaw kamiwaza mode] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/dev/lima/bootstrap-kamiwaza-mode.sh [options]

Installs the trusted/untrusted OpenClaw Lima VM pair in Kamiwaza mode, wires
Locksmith and Pipelock through the existing runtime bootstrap, and deploys a
configurable set of local Kamiwaza extension repositories through the same
workspace-push path used by ~/code/kz/amatt-push-local-extensions.sh.

Environment:
  OPENCLAW_RUNTIME_NAME                  Runtime name, default openclaw.
  OPENCLAW_RUNTIME_PORT_OFFSET           Numeric port offset for additional VM pairs.
  OPENCLAW_KAMIWAZA_EXTENSION_HELPER     Extension deploy helper, default ~/code/kz/amatt-push-local-extensions.sh.
  OPENCLAW_KAMIWAZA_EXTENSION_TARGETS    Comma/newline separated target specs:
                                          /repo/path[:tool|app|service[:target-name]]
  OPENCLAW_KAMIWAZA_EXTENSION_NAMESPACE  Kubernetes namespace for active CRs, default kamiwaza-extensions.
  OPENCLAW_KAMIWAZA_DEPLOYMENT_SUFFIX    Suffix for active deployment ids, default openclaw.
  OPENCLAW_KAMIWAZA_LOCAL_REGISTRY        Registry used by active CRs, default registry.infra.kamiwaza.test:5001.
  OPENCLAW_KAMIWAZA_IMAGE_TAG_SUFFIX      Local image tag suffix, default -dev.
  OPENCLAW_KAMIWAZA_PREPULL_IMAGES        Pull local HTTP-registry images into k0s first, default 1.
  OPENCLAW_KAMIWAZA_K0S_VM                Lima VM containing k0s, default kamiwaza-k0s.
  OPENCLAW_KAMIWAZA_TOOL_EGRESS_PROXY     Proxy for active tool pods, default http://host.lima.internal:$OPENCLAW_PIPELOCK_PORT.
  OPENCLAW_KAMIWAZA_NO_PROXY              NO_PROXY for active tool pods.
  IMAGE_PREFIX                           Local extension image prefix, default kamiwazaai.
  OPENCLAW_AGENT_STATE_HOST_DIR          Optional host directory mounted writable into the gateway VM only.
  OPENCLAW_MAIN_AGENT_WORKSPACE          Guest workspace path for the trusted main agent.
                                          Defaults to OPENCLAW_AGENT_STATE_HOST_DIR when set.
  OPENCLAW_API_KEYS_FILE                 Optional API key env file, default ~/.api_keys.
  OPENCLAW_LOAD_API_KEYS                 Set to 0 to skip loading OPENCLAW_API_KEYS_FILE.
  OPENCLAW_KAMIWAZA_LOGIN_SCRIPT         Optional kz-login helper, default ~/code/kz/deploy/scripts/kz-login.
  OPENCLAW_KAMIWAZA_BASE_URL             Model endpoint seen by the VM, default http://host.lima.internal:4000/v1.
  OPENCLAW_KAMIWAZA_MODEL_ID             Model id to install into OpenClaw config.
  OPENCLAW_KAMIWAZA_MODEL_API_KEY        Optional model endpoint bearer token, stored in the gateway guest as a redacted env secret.
  OPENCLAW_KAMIWAZA_MODEL_API_KEY_ENV    Env var name referenced by OpenClaw config, default OPENCLAW_KAMIWAZA_MODEL_API_KEY.
  OPENCLAW_UNTRUSTED_CONTENT_AUTH_ENABLED App auth for active local untrusted-content, default false.

Default extension targets:
  ~/code/kz/kamiwaza-extensions-serperdev:tool:tool-serperdev
  ~/code/kz/kamiwaza-extensions-tool-untrusted:tool:tool-untrusted-content

Options:
  --dry-run                              Print the plan and pass --dry-run to the extension helper.
  --no-bootstrap                         Skip VM creation/configuration.
  --no-extensions                        Skip Kamiwaza extension deployment.
  --no-push-extensions                   Skip the helper/template push, but still apply active CRs.
  --no-activate-extensions               Push templates, but do not apply active KamiwazaExtension CRs.
  --no-wait-extensions                   Do not wait for active KamiwazaExtension CRs to become Ready.
  --extension-target SPEC                Add one target spec to the configured target set.
  --extension-helper PATH                Override OPENCLAW_KAMIWAZA_EXTENSION_HELPER.
  --extension-helper-arg ARG             Append one argument to the extension helper.
  --extension-deployment-suffix SUFFIX    Override OPENCLAW_KAMIWAZA_DEPLOYMENT_SUFFIX.
  --agent-state-host-dir PATH            Override OPENCLAW_AGENT_STATE_HOST_DIR.
  --no-install                           Pass through to bootstrap-claw-runtime.sh.
  --no-credentials                       Pass through to bootstrap-claw-runtime.sh.
  --no-gateway-service                   Pass through to bootstrap-claw-runtime.sh.
  --no-verify                            Pass through to bootstrap-claw-runtime.sh.
  -h, --help                             Show this help.

Examples:
  scripts/dev/lima/bootstrap-kamiwaza-mode.sh

  OPENCLAW_RUNTIME_NAME=openclaw-kz-smoke OPENCLAW_RUNTIME_PORT_OFFSET=3000 \
    scripts/dev/lima/bootstrap-kamiwaza-mode.sh \
      --agent-state-host-dir "$HOME/agent-state/openclaw-kz-smoke"
USAGE
}

run_or_print() {
  if [[ "$DRY_RUN" == "1" ]]; then
    local first=1
    printf '[openclaw kamiwaza mode] dry-run command:'
    for arg in "$@"; do
      if [[ "$first" == "1" ]]; then
        first=0
      fi
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi
  "$@"
}

absolute_path() {
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

target_kind_dir() {
  case "$1" in
    tool | tools) printf 'tools\n' ;;
    app | apps) printf 'apps\n' ;;
    service | services) printf 'services\n' ;;
    "") printf '\n' ;;
    *) die "unsupported Kamiwaza extension target kind: $1" ;;
  esac
}

split_target_spec() {
  local spec="$1"
  local repo="${spec%%:*}"
  local rest=""
  TARGET_KIND=""
  TARGET_NAME=""
  if [[ "$spec" == *:* ]]; then
    rest="${spec#*:}"
    TARGET_KIND="${rest%%:*}"
    if [[ "$rest" == *:* ]]; then
      TARGET_NAME="${rest#*:}"
    fi
  fi
  TARGET_REPO="$(absolute_path "$repo")"
}

default_extension_targets() {
  cat <<TARGETS
$HOME/code/kz/kamiwaza-extensions-serperdev:tool:tool-serperdev
$HOME/code/kz/kamiwaza-extensions-tool-untrusted:tool:tool-untrusted-content
TARGETS
}

collect_extension_targets() {
  local configured="${OPENCLAW_KAMIWAZA_EXTENSION_TARGETS:-}"
  if [[ -z "$configured" ]]; then
    configured="$(default_extension_targets)"
  fi
  printf '%s\n' "$configured" | tr ',' '\n'
  if [[ "${#EXTRA_TARGETS[@]}" -gt 0 ]]; then
    printf '%s\n' "${EXTRA_TARGETS[@]}"
  fi
}

validate_target_spec() {
  local spec="$1"
  split_target_spec "$spec"
  [[ -d "$TARGET_REPO" ]] || die "extension repo not found: $TARGET_REPO"

  local kind_dir
  kind_dir="$(target_kind_dir "$TARGET_KIND")"
  if [[ -n "$kind_dir" && -n "$TARGET_NAME" ]]; then
    [[ -f "$TARGET_REPO/$kind_dir/$TARGET_NAME/kamiwaza.json" ]] ||
      die "target $TARGET_KIND/$TARGET_NAME is missing kamiwaza.json in $TARGET_REPO"
  fi

  printf '%s\n' "$TARGET_REPO"
}

resolve_target_manifest() {
  local spec="$1"
  split_target_spec "$spec"
  [[ -d "$TARGET_REPO" ]] || die "extension repo not found: $TARGET_REPO"

  local kind_dir
  kind_dir="$(target_kind_dir "$TARGET_KIND")"
  if [[ -n "$kind_dir" && -n "$TARGET_NAME" ]]; then
    local explicit="$TARGET_REPO/$kind_dir/$TARGET_NAME/kamiwaza.json"
    [[ -f "$explicit" ]] || die "target $TARGET_KIND/$TARGET_NAME is missing kamiwaza.json in $TARGET_REPO"
    printf '%s\n' "$explicit"
    return
  fi

  local manifests=()
  while IFS= read -r manifest || [[ -n "$manifest" ]]; do
    manifests+=("$manifest")
  done < <(find "$TARGET_REPO" -mindepth 3 -maxdepth 3 -name kamiwaza.json -print | sort)

  if [[ "${#manifests[@]}" -eq 1 ]]; then
    printf '%s\n' "${manifests[0]}"
    return
  fi
  die "target spec must include kind and target name when a repo has ${#manifests[@]} manifests: $spec"
}

prepare_selected_extension_workspace() {
  local selected_root="$1"
  shift
  mkdir -p "$selected_root"

  local repo name link
  for repo in "$@"; do
    name="$(basename "$repo")"
    link="$selected_root/$name"
    if [[ -e "$link" || -L "$link" ]]; then
      die "duplicate selected extension repo basename: $name"
    fi
    ln -s "$repo" "$link"
  done
}

load_api_keys() {
  if [[ "${OPENCLAW_LOAD_API_KEYS:-1}" == "0" ]]; then
    log "skipping API key env load"
    return
  fi

  local api_keys_file="${OPENCLAW_API_KEYS_FILE:-$HOME/.api_keys}"
  if [[ "$api_keys_file" == "~" || "$api_keys_file" == "~/"* ]]; then
    api_keys_file="$HOME${api_keys_file:1}"
  fi
  if [[ ! -f "$api_keys_file" ]]; then
    log "API key file not found at $api_keys_file; continuing without local tool secrets"
    return
  fi

  local restore_xtrace=0
  if [[ "$-" == *x* ]]; then
    restore_xtrace=1
    set +x
  fi

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${#value}" -ge 2 && "${value:0:1}" == "\"" && "${value: -1}" == "\"" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${#value}" -ge 2 && "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$key=$value"
  done <"$api_keys_file"

  if [[ -n "${SERPER_API_KEY:-}" ]]; then
    log "SERPER_API_KEY present (value redacted)"
    if [[ -z "${SERPERDEV_API_KEY:-}" ]]; then
      export SERPERDEV_API_KEY="$SERPER_API_KEY"
      log "SERPERDEV_API_KEY derived from SERPER_API_KEY (value redacted)"
    fi
  else
    log "SERPER_API_KEY missing; Serper-backed tools may not be usable"
  fi

  if [[ "$restore_xtrace" == "1" ]]; then
    set -x
  fi
}

resolve_kamiwaza_password() {
  if [[ -n "${KAMIWAZA_PASSWORD:-}" ]]; then
    log "KAMIWAZA_PASSWORD present (value redacted)"
    return
  fi

  local login_script="${OPENCLAW_KAMIWAZA_LOGIN_SCRIPT:-$HOME/code/kz/deploy/scripts/kz-login}"
  login_script="$(absolute_path "$login_script")"
  if [[ ! -x "$login_script" ]]; then
    log "KAMIWAZA_PASSWORD missing and login helper not executable at $login_script"
    return
  fi

  local restore_xtrace=0
  if [[ "$-" == *x* ]]; then
    restore_xtrace=1
    set +x
  fi

  local password=""
  password="$("$login_script" --show-password 2>/dev/null | tr -d '\r\n' || true)"
  if [[ -z "$password" ]]; then
    log "KAMIWAZA_PASSWORD login helper returned an empty value"
    if [[ "$restore_xtrace" == "1" ]]; then
      set -x
    fi
    return
  fi
  export KAMIWAZA_PASSWORD="$password"
  log "KAMIWAZA_PASSWORD resolved from $login_script (value redacted)"
  if [[ "$restore_xtrace" == "1" ]]; then
    set -x
  fi
}

plan_agent_state_mount() {
  local state_dir="${OPENCLAW_AGENT_STATE_HOST_DIR:-}"
  if [[ -z "$state_dir" ]]; then
    return
  fi

  state_dir="$(absolute_path "$state_dir")"
  export OPENCLAW_AGENT_STATE_HOST_DIR="$state_dir"
  export OPENCLAW_MAIN_AGENT_WORKSPACE="${OPENCLAW_MAIN_AGENT_WORKSPACE:-$state_dir}"
  mkdir -p "$state_dir"

  log "agent state host dir: $OPENCLAW_AGENT_STATE_HOST_DIR"
  log "OPENCLAW_MAIN_AGENT_WORKSPACE=$OPENCLAW_MAIN_AGENT_WORKSPACE"
  log "gateway-only writable Lima mount enabled; untrusted VM keeps no host workspace mount"
}

deploy_extensions() {
  local helper="${OPENCLAW_KAMIWAZA_EXTENSION_HELPER:-$HOME/code/kz/amatt-push-local-extensions.sh}"
  helper="$(absolute_path "$helper")"
  [[ -x "$helper" ]] || die "Kamiwaza extension helper is not executable: $helper"
  export IMAGE_PREFIX="${IMAGE_PREFIX:-kamiwazaai}"
  log "IMAGE_PREFIX=$IMAGE_PREFIX for local extension builds"

  local repos=()
  local spec repo
  while IFS= read -r spec || [[ -n "$spec" ]]; do
    spec="${spec#"${spec%%[![:space:]]*}"}"
    spec="${spec%"${spec##*[![:space:]]}"}"
    [[ -z "$spec" || "$spec" == \#* ]] && continue
    repo="$(validate_target_spec "$spec")"
    repos+=("$repo")
  done < <(collect_extension_targets)

  if [[ "${#repos[@]}" -eq 0 ]]; then
    log "no Kamiwaza extension targets configured"
    return
  fi

  openclaw_prepare_runtime_dirs
  local selected_root
  selected_root="$(mktemp -d "$OPENCLAW_RUNTIME_DIR/metadata/kamiwaza-selected-extensions.XXXXXX")"
  prepare_selected_extension_workspace "$selected_root" "${repos[@]}"

  log "deploying selected Kamiwaza extension repos from $selected_root"
  for repo in "${repos[@]}"; do
    log "selected extension repo: $repo"
  done

  local cmd=("$helper" "--workspace" "$selected_root")
  if [[ "$DRY_RUN" == "1" ]]; then
    cmd+=("--dry-run")
  fi
  if [[ "${#EXTENSION_HELPER_ARGS[@]}" -gt 0 ]]; then
    cmd+=("${EXTENSION_HELPER_ARGS[@]}")
  fi
  run_or_print "${cmd[@]}"
}

node_json_field() {
  local manifest="$1"
  local field="$2"
  node - "$manifest" "$field" <<'NODE'
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const value = manifest[process.argv[3]];
if (value === undefined || value === null) {
  process.exit(0);
}
process.stdout.write(String(value));
NODE
}

deployment_id_for_manifest() {
  local manifest="$1"
  local name suffix
  name="$(node_json_field "$manifest" name)"
  [[ -n "$name" ]] || die "kamiwaza manifest is missing name: $manifest"
  suffix="${OPENCLAW_KAMIWAZA_DEPLOYMENT_SUFFIX:-openclaw}"
  printf '%s-%s\n' "$name" "$suffix"
}

extension_secret_env_specs() {
  local manifest="$1"
  node - "$manifest" <<'NODE'
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const envDefaults = manifest.env_defaults && typeof manifest.env_defaults === "object" ? manifest.env_defaults : {};
const required = new Set(Array.isArray(manifest.required_env_vars) ? manifest.required_env_vars : []);
const explicitSecrets = new Set(
  (process.env.OPENCLAW_KAMIWAZA_SECRET_ENV_VARS || "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean),
);
const secretish = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/;
const names = new Set(required);
for (const name of Object.keys(envDefaults)) {
  if (explicitSecrets.has(name) || (process.env[name] && secretish.test(name))) {
    names.add(name);
  }
}
for (const name of explicitSecrets) {
  names.add(name);
}
for (const name of Array.from(names).sort()) {
  process.stdout.write(`${required.has(name) ? "required" : "optional"}\t${name}\n`);
}
NODE
}

apply_extension_secret() {
  local namespace="$1"
  local secret_name="$2"
  local manifest="$3"
  local secret_file=""
  local has_values=0
  local mode name value
  local restore_xtrace=0

  if [[ "$-" == *x* ]]; then
    restore_xtrace=1
    set +x
  fi

  openclaw_prepare_runtime_dirs
  secret_file="$(mktemp "$OPENCLAW_RUNTIME_DIR/metadata/${secret_name}.env.XXXXXX")"
  chmod 0600 "$secret_file"

  while IFS=$'\t' read -r mode name || [[ -n "$name" ]]; do
    [[ -z "$name" ]] && continue
    value="${!name:-}"
    if [[ -z "$value" ]]; then
      if [[ "$mode" == "required" ]]; then
        rm -f "$secret_file"
        if [[ "$restore_xtrace" == "1" ]]; then
          set -x
        fi
        die "$name is required by $(node_json_field "$manifest" name) but is not set"
      fi
      continue
    fi
    printf '%s=%s\n' "$name" "$value" >>"$secret_file"
    has_values=1
  done < <(extension_secret_env_specs "$manifest")

  if [[ "$has_values" != "1" ]]; then
    rm -f "$secret_file"
    if [[ "$restore_xtrace" == "1" ]]; then
      set -x
    fi
    return
  fi

  log "applying Kubernetes secret $secret_name in $namespace (values redacted)"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run command: kubectl -n $namespace create secret generic $secret_name --from-env-file=<redacted> --dry-run=client -o yaml | kubectl apply -f -"
  else
    kubectl -n "$namespace" create secret generic "$secret_name" \
      --from-env-file="$secret_file" \
      --dry-run=client \
      -o yaml | kubectl apply -f -
  fi
  rm -f "$secret_file"
  if [[ "$restore_xtrace" == "1" ]]; then
    set -x
  fi
}

generate_extension_cr_json() {
  local manifest="$1"
  local target_kind="$2"
  local deployment_id="$3"
  local secret_name="$4"
  node - "$manifest" "$target_kind" "$deployment_id" "$secret_name" <<'NODE'
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const targetKind = process.argv[3] || manifest.template_type || "tool";
const deploymentId = process.argv[4];
const secretName = process.argv[5];

const name = manifest.name;
if (!name) {
  throw new Error(`kamiwaza manifest is missing name: ${process.argv[2]}`);
}

const version = String(manifest.version || "0.0.0");
const namespace = process.env.OPENCLAW_KAMIWAZA_EXTENSION_NAMESPACE || "kamiwaza-extensions";
const registry = process.env.OPENCLAW_KAMIWAZA_LOCAL_REGISTRY || "registry.infra.kamiwaza.test:5001";
const imagePrefix = process.env.IMAGE_PREFIX || "kamiwazaai";
const imageTagSuffix = process.env.OPENCLAW_KAMIWAZA_IMAGE_TAG_SUFFIX || "-dev";
const repository = `${imagePrefix}/${name}`;
const tag = `${version}${imageTagSuffix}`;
const origin = process.env.OPENCLAW_KAMIWAZA_ORIGIN || "https://yod.local";
const apiUrl = process.env.OPENCLAW_KAMIWAZA_API_URL || `${origin}/api`;
const publicApiUrl = process.env.OPENCLAW_KAMIWAZA_PUBLIC_API_URL || apiUrl;
const proxyUrl = (process.env.OPENCLAW_KAMIWAZA_TOOL_EGRESS_PROXY || "").trim();
const noProxy =
  process.env.OPENCLAW_KAMIWAZA_NO_PROXY ||
  "localhost,127.0.0.1,.svc,.cluster.local,kubernetes.default.svc,yod.local,host.lima.internal,host.docker.internal";
const explicitSecrets = new Set(
  (process.env.OPENCLAW_KAMIWAZA_SECRET_ENV_VARS || "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean),
);
const secretish = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/;
const required = new Set(Array.isArray(manifest.required_env_vars) ? manifest.required_env_vars : []);
const envDefaults = manifest.env_defaults && typeof manifest.env_defaults === "object" ? manifest.env_defaults : {};
const secretNames = new Set(required);
for (const [envName] of Object.entries(envDefaults)) {
  if (explicitSecrets.has(envName) || (process.env[envName] && secretish.test(envName))) {
    secretNames.add(envName);
  }
}
for (const envName of explicitSecrets) {
  if (process.env[envName]) {
    secretNames.add(envName);
  }
}

const env = [];
const seen = new Set();
function addLiteral(envName, value) {
  if (seen.has(envName)) return;
  seen.add(envName);
  env.push(value === "" || value === undefined || value === null ? { name: envName } : { name: envName, value: String(value) });
}
function addSecret(envName) {
  if (seen.has(envName)) return;
  seen.add(envName);
  env.push({
    name: envName,
    valueFrom: {
      secretKeyRef: {
        name: secretName,
        key: envName,
      },
    },
  });
}

for (const [envName, defaultValue] of Object.entries(envDefaults)) {
  if (secretNames.has(envName)) {
    addSecret(envName);
  } else if (envName === "KAMIWAZA_API_URL") {
    addLiteral(envName, apiUrl);
  } else if (envName === "KAMIWAZA_ENDPOINT") {
    addLiteral(envName, origin);
  } else if (name === "tool-untrusted-content" && envName === "UTC_AUTH_ENABLED") {
    addLiteral(envName, process.env.OPENCLAW_UNTRUSTED_CONTENT_AUTH_ENABLED || "false");
  } else if (Object.prototype.hasOwnProperty.call(process.env, envName)) {
    addLiteral(envName, process.env[envName]);
  } else {
    addLiteral(envName, defaultValue);
  }
}
for (const envName of Array.from(required).sort()) {
  addSecret(envName);
}

addLiteral("KAMIWAZA_API_URL", apiUrl);
if (name === "tool-untrusted-content") {
  addLiteral("KAMIWAZA_ENDPOINT", origin);
}
if (name === "tool-telegram") {
  addLiteral("KAMIWAZA_USE_AUTH", "true");
}
if (proxyUrl && proxyUrl !== "0" && proxyUrl.toLowerCase() !== "none") {
  addLiteral("HTTP_PROXY", proxyUrl);
  addLiteral("HTTPS_PROXY", proxyUrl);
  addLiteral("NO_PROXY", noProxy);
}

const service = {
  name: targetKind === "tool" ? "tool" : targetKind,
  primary: true,
  replicas: 1,
  image: {
    registry,
    repository,
    tag,
    pullPolicy: "IfNotPresent",
  },
  ports: [{ name: "http", containerPort: Number(process.env.OPENCLAW_KAMIWAZA_EXTENSION_PORT || envDefaults.PORT || 8000), protocol: "TCP" }],
  healthCheck: {
    httpGet: { path: process.env.OPENCLAW_KAMIWAZA_HEALTH_PATH || "/health", port: Number(process.env.OPENCLAW_KAMIWAZA_EXTENSION_PORT || envDefaults.PORT || 8000) },
    initialDelaySeconds: 10,
    startPeriod: 60,
    periodSeconds: 10,
    timeoutSeconds: 5,
    failureThreshold: 6,
  },
  env,
  resources: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: name === "tool-telegram" ? "500m" : "2", memory: name === "tool-telegram" ? "512Mi" : "2Gi" },
  },
};

if (name === "tool-telegram") {
  service.persistence = { enabled: true, mountPath: "/data", size: "1Gi" };
} else if (name === "tool-untrusted-content") {
  service.persistence = { enabled: true, mountPath: envDefaults.UTC_DATA_ROOT || "/var/lib/untrusted-content", size: "1Gi" };
}

const security = {
  riskTier: Number(manifest.risk_tier || 1),
  sourceType: manifest.source_type || "kamiwaza",
  podSecurityContext: { seccompProfile: { type: "RuntimeDefault" } },
  containerSecurityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
};
if (name === "tool-telegram") {
  security.podSecurityContext = {
    fsGroup: 1000,
    runAsNonRoot: true,
    runAsUser: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  };
  security.containerSecurityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
    runAsGroup: 1000,
    runAsNonRoot: true,
    runAsUser: 1000,
  };
}

const cr = {
  apiVersion: "extensions.kamiwaza.io/v1alpha1",
  kind: "KamiwazaExtension",
  metadata: {
    name: deploymentId,
    namespace,
    labels: {
      "extensions.kamiwaza.io/name": name,
      "extensions.kamiwaza.io/type": targetKind,
      "extensions.kamiwaza.io/version": version,
      "extensions.kamiwaza.io/risk-tier": String(security.riskTier),
    },
  },
  spec: {
    type: targetKind,
    extensionRef: {
      registry: "local",
      templateName: name,
      name,
      version,
    },
    kamiwaza: {
      namespace: process.env.OPENCLAW_KAMIWAZA_CONTROL_NAMESPACE || "kamiwaza",
      origin,
      apiUrl,
      publicApiUrl,
      useAuth: "true",
      tlsRejectUnauthorized: process.env.OPENCLAW_KAMIWAZA_TLS_REJECT_UNAUTHORIZED || "0",
    },
    networking: {
      ingress: {
        enabled: true,
        priority: Number(process.env.OPENCLAW_KAMIWAZA_INGRESS_PRIORITY || 1500),
        stripPrefix: true,
      },
      networkPolicy: {
        enabled: true,
        allowExternalAccess: true,
        allowNamespaces: ["kamiwaza", "istio-system"],
      },
    },
    security,
    services: [service],
  },
};

process.stdout.write(`${JSON.stringify(cr, null, 2)}\n`);
NODE
}

extension_image_ref() {
  local manifest="$1"
  node - "$manifest" <<'NODE'
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const name = manifest.name;
const version = String(manifest.version || "0.0.0");
const registry = process.env.OPENCLAW_KAMIWAZA_LOCAL_REGISTRY || "registry.infra.kamiwaza.test:5001";
const imagePrefix = process.env.IMAGE_PREFIX || "kamiwazaai";
const imageTagSuffix = process.env.OPENCLAW_KAMIWAZA_IMAGE_TAG_SUFFIX || "-dev";
process.stdout.write(`${registry}/${imagePrefix}/${name}:${version}${imageTagSuffix}`);
NODE
}

prepull_extension_image() {
  local image_ref="$1"
  if [[ "${OPENCLAW_KAMIWAZA_PREPULL_IMAGES:-1}" == "0" ]]; then
    return
  fi
  local k0s_vm="${OPENCLAW_KAMIWAZA_K0S_VM:-kamiwaza-k0s}"
  if [[ "$DRY_RUN" != "1" ]] && ! command -v limactl >/dev/null 2>&1; then
    die "limactl is required for local image pre-pull; set OPENCLAW_KAMIWAZA_PREPULL_IMAGES=0 to skip"
  fi
  log "pre-pulling local registry image into $k0s_vm: $image_ref"
  if [[ -n "${OPENCLAW_KAMIWAZA_LIMA_HOME:-}" ]]; then
    run_or_print env "LIMA_HOME=$OPENCLAW_KAMIWAZA_LIMA_HOME" limactl shell --workdir /tmp "$k0s_vm" -- sudo k0s ctr -n k8s.io images pull --plain-http "$image_ref"
  else
    run_or_print env -u LIMA_HOME limactl shell --workdir /tmp "$k0s_vm" -- sudo k0s ctr -n k8s.io images pull --plain-http "$image_ref"
  fi
}

limactl_kamiwaza_shell() {
  local k0s_vm="${OPENCLAW_KAMIWAZA_K0S_VM:-kamiwaza-k0s}"
  if [[ -n "${OPENCLAW_KAMIWAZA_LIMA_HOME:-}" ]]; then
    env "LIMA_HOME=$OPENCLAW_KAMIWAZA_LIMA_HOME" limactl shell --workdir /tmp "$k0s_vm" -- "$@"
  else
    env -u LIMA_HOME limactl shell --workdir /tmp "$k0s_vm" -- "$@"
  fi
}

default_tool_egress_proxy() {
  local gateway_ip=""
  if command -v limactl >/dev/null 2>&1; then
    gateway_ip="$(
      limactl_kamiwaza_shell sh -lc \
        'getent hosts host.lima.internal host.docker.internal 2>/dev/null | awk '"'"'{print $1; exit}'"'"' || ip route | awk '"'"'$5 == "eth0" && /default/ {print $3; exit}'"'"'' \
        2>/dev/null |
        tr -d '\r\n' ||
        true
    )"
  fi
  if [[ -n "$gateway_ip" ]]; then
    printf 'http://%s:%s\n' "$gateway_ip" "$OPENCLAW_PIPELOCK_PORT"
    return
  fi
  printf 'http://host.lima.internal:%s\n' "$OPENCLAW_PIPELOCK_PORT"
}

apply_active_extension() {
  local spec="$1"
  local namespace="${OPENCLAW_KAMIWAZA_EXTENSION_NAMESPACE:-kamiwaza-extensions}"
  local manifest target_kind deployment_id secret_name cr_file image_ref
  manifest="$(resolve_target_manifest "$spec")"
  split_target_spec "$spec"
  target_kind="${TARGET_KIND:-$(node_json_field "$manifest" template_type)}"
  target_kind="${target_kind:-tool}"
  deployment_id="$(deployment_id_for_manifest "$manifest")"
  secret_name="openclaw-required-env-$deployment_id"
  image_ref="$(extension_image_ref "$manifest")"

  log "ensuring active KamiwazaExtension $deployment_id from $manifest"
  apply_extension_secret "$namespace" "$secret_name" "$manifest"
  prepull_extension_image "$image_ref"

  openclaw_prepare_runtime_dirs
  cr_file="$(mktemp "$OPENCLAW_RUNTIME_DIR/metadata/${deployment_id}.kext.XXXXXX")"
  generate_extension_cr_json "$manifest" "$target_kind" "$deployment_id" "$secret_name" >"$cr_file"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run command: kubectl apply --server-side --force-conflicts -f $cr_file"
  else
    kubectl apply --server-side --force-conflicts -f "$cr_file"
  fi
}

ensure_active_extensions() {
  if [[ "$RUN_EXTENSION_ACTIVATION" != "1" ]]; then
    log "skipping active KamiwazaExtension CR application"
    return
  fi
  export IMAGE_PREFIX="${IMAGE_PREFIX:-kamiwazaai}"
  export OPENCLAW_KAMIWAZA_TOOL_EGRESS_PROXY="${OPENCLAW_KAMIWAZA_TOOL_EGRESS_PROXY:-$(default_tool_egress_proxy)}"
  log "active tool egress proxy: $OPENCLAW_KAMIWAZA_TOOL_EGRESS_PROXY"

  if [[ "$DRY_RUN" != "1" ]] && ! command -v kubectl >/dev/null 2>&1; then
    die "kubectl is required to apply active KamiwazaExtension CRs"
  fi

  local namespace="${OPENCLAW_KAMIWAZA_EXTENSION_NAMESPACE:-kamiwaza-extensions}"
  log "active KamiwazaExtension namespace: $namespace"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run command: kubectl get namespace $namespace || kubectl create namespace $namespace"
  else
    kubectl get namespace "$namespace" >/dev/null 2>&1 || kubectl create namespace "$namespace"
  fi
  log "waiting for KamiwazaExtension CRD to be established"
  run_or_print kubectl wait \
    --for=condition=Established \
    crd/kamiwazaextensions.extensions.kamiwaza.io \
    "--timeout=${OPENCLAW_KAMIWAZA_CRD_WAIT_TIMEOUT:-60s}"

  local deployment_ids=()
  local target_specs=()
  local spec manifest deployment_id
  while IFS= read -r spec || [[ -n "$spec" ]]; do
    spec="${spec#"${spec%%[![:space:]]*}"}"
    spec="${spec%"${spec##*[![:space:]]}"}"
    [[ -z "$spec" || "$spec" == \#* ]] && continue
    target_specs+=("$spec")
  done < <(collect_extension_targets)

  for spec in "${target_specs[@]}"; do
    manifest="$(resolve_target_manifest "$spec")"
    deployment_id="$(deployment_id_for_manifest "$manifest")"
    deployment_ids+=("$deployment_id")
    apply_active_extension "$spec"
  done

  if [[ "$WAIT_FOR_EXTENSIONS" != "1" ]]; then
    return
  fi
  local timeout="${OPENCLAW_KAMIWAZA_EXTENSION_WAIT_TIMEOUT:-180s}"
  for deployment_id in "${deployment_ids[@]}"; do
    log "waiting for $deployment_id to become Ready (timeout $timeout)"
    run_or_print kubectl wait \
      --for=condition=Ready \
      "kamiwazaextension.extensions.kamiwaza.io/$deployment_id" \
      -n "$namespace" \
      "--timeout=$timeout"
  done
}

print_kimi_note() {
  local base_url="${OPENCLAW_KAMIWAZA_BASE_URL:-http://host.lima.internal:4000/v1}"
  local model_id="${OPENCLAW_KAMIWAZA_MODEL_ID:-kamiwaza/relic/MiniMax-M2.7-AWQ-4bit}"
  local model_api_key_env="${OPENCLAW_KAMIWAZA_MODEL_API_KEY_ENV:-OPENCLAW_KAMIWAZA_MODEL_API_KEY}"
  log "Kimi endpoint note: OPENCLAW_KAMIWAZA_BASE_URL=$base_url"
  log "Kimi endpoint note: OPENCLAW_KAMIWAZA_MODEL_ID=$model_id"
  if [[ -n "${OPENCLAW_KAMIWAZA_MODEL_API_KEY:-}" ]]; then
    log "Kimi endpoint note: OPENCLAW_KAMIWAZA_MODEL_API_KEY present (value redacted; guest env $model_api_key_env)"
  fi
  log "Kimi endpoint note: set OPENCLAW_KAMIWAZA_MODEL_ID to a discovered Kamiwaza Kimi alias such as kamiwaza/tokenator/Kimi-K2.5 when available."
}

run_bootstrap() {
  if [[ "$RUN_BOOTSTRAP" != "1" ]]; then
    log "skipping OpenClaw VM bootstrap"
    return
  fi
  local cmd=("bash" "$SCRIPT_DIR/bootstrap-claw-runtime.sh")
  if [[ "${#BOOTSTRAP_ARGS[@]}" -gt 0 ]]; then
    cmd+=("${BOOTSTRAP_ARGS[@]}")
  fi
  OPENCLAW_AGENT_STATE_HOST_DIR="${OPENCLAW_AGENT_STATE_HOST_DIR:-}" \
    OPENCLAW_MAIN_AGENT_WORKSPACE="${OPENCLAW_MAIN_AGENT_WORKSPACE:-}" \
    run_or_print "${cmd[@]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-bootstrap)
      RUN_BOOTSTRAP=0
      shift
      ;;
    --no-extensions)
      RUN_EXTENSIONS=0
      RUN_EXTENSION_PUSH=0
      RUN_EXTENSION_ACTIVATION=0
      shift
      ;;
    --no-push-extensions)
      RUN_EXTENSION_PUSH=0
      shift
      ;;
    --no-activate-extensions)
      RUN_EXTENSION_ACTIVATION=0
      shift
      ;;
    --no-wait-extensions)
      WAIT_FOR_EXTENSIONS=0
      shift
      ;;
    --extension-target)
      [[ $# -ge 2 ]] || die "--extension-target requires a value"
      EXTRA_TARGETS+=("$2")
      shift 2
      ;;
    --extension-helper)
      [[ $# -ge 2 ]] || die "--extension-helper requires a value"
      OPENCLAW_KAMIWAZA_EXTENSION_HELPER="$2"
      export OPENCLAW_KAMIWAZA_EXTENSION_HELPER
      shift 2
      ;;
    --extension-helper-arg)
      [[ $# -ge 2 ]] || die "--extension-helper-arg requires a value"
      EXTENSION_HELPER_ARGS+=("$2")
      shift 2
      ;;
    --extension-deployment-suffix)
      [[ $# -ge 2 ]] || die "--extension-deployment-suffix requires a value"
      OPENCLAW_KAMIWAZA_DEPLOYMENT_SUFFIX="$2"
      export OPENCLAW_KAMIWAZA_DEPLOYMENT_SUFFIX
      shift 2
      ;;
    --agent-state-host-dir)
      [[ $# -ge 2 ]] || die "--agent-state-host-dir requires a value"
      OPENCLAW_AGENT_STATE_HOST_DIR="$2"
      export OPENCLAW_AGENT_STATE_HOST_DIR
      shift 2
      ;;
    --no-install | --no-credentials | --no-gateway-service | --no-verify)
      BOOTSTRAP_ARGS+=("$1")
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

print_kimi_note
load_api_keys
resolve_kamiwaza_password
plan_agent_state_mount

if [[ "$RUN_EXTENSIONS" == "1" ]]; then
  if [[ "$RUN_EXTENSION_PUSH" == "1" ]]; then
    deploy_extensions
  else
    log "skipping Kamiwaza extension helper/template push"
  fi
  ensure_active_extensions
else
  log "skipping Kamiwaza extension deployment"
fi

run_bootstrap
log "Kamiwaza mode bootstrap complete"
