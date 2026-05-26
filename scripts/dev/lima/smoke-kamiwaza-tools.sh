#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[openclaw kamiwaza smoke] %s\n' "$*"
}

die() {
  printf '[openclaw kamiwaza smoke] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: bash scripts/dev/lima/smoke-kamiwaza-tools.sh [--call] [--no-locksmith]

Runs a secret-safe Kamiwaza tool plumbing smoke from the OpenClaw runtime
environment. Intended for the openclaw-gateway Lima guest after
bootstrap-claw-runtime.sh has installed OpenClaw, Locksmith, and the Kamiwaza
PAT store.

Environment:
  OPENCLAW_CLI                         OpenClaw CLI binary (default: openclaw)
  OPENCLAW_KAMIWAZA_REQUIRE_TOOLS      Require at least one direct tool (default: 1)
  OPENCLAW_KAMIWAZA_REQUIRE_LOCKSMITH  Require Locksmith catalog reachability (default: 1)
  OPENCLAW_KAMIWAZA_SMOKE_TOOL         Tool slug to call when --call is set
  OPENCLAW_KAMIWAZA_SMOKE_ARGS         JSON object args for calls (default: {})
  OPENCLAW_KAMIWAZA_SMOKE_AGENT_ID     Delegated direct-call identity (default: openclaw-smoke)

The script prints only summaries, never PATs or bearer tokens.
USAGE
}

CALL_TOOL=0
CHECK_LOCKSMITH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --call)
      CALL_TOOL=1
      shift
      ;;
    --no-locksmith)
      CHECK_LOCKSMITH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

OPENCLAW_CLI="${OPENCLAW_CLI:-openclaw}"
REQUIRE_TOOLS="${OPENCLAW_KAMIWAZA_REQUIRE_TOOLS:-1}"
REQUIRE_LOCKSMITH="${OPENCLAW_KAMIWAZA_REQUIRE_LOCKSMITH:-1}"
SMOKE_TOOL="${OPENCLAW_KAMIWAZA_SMOKE_TOOL:-}"
SMOKE_ARGS="${OPENCLAW_KAMIWAZA_SMOKE_ARGS:-{}}"
SMOKE_AGENT_ID="${OPENCLAW_KAMIWAZA_SMOKE_AGENT_ID:-openclaw-smoke}"

command -v "$OPENCLAW_CLI" >/dev/null 2>&1 || die "OpenClaw CLI not found: $OPENCLAW_CLI"
command -v jq >/dev/null 2>&1 || die "jq is required"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

run_json() {
  local label="$1"
  local out="$2"
  shift 2
  local err="$out.stderr"
  if ! "$@" >"$out" 2>"$err"; then
    sed 's/^/  /' "$err" >&2
    die "$label failed"
  fi
  jq . "$out" >/dev/null || die "$label did not emit valid JSON"
}

log "checking direct Kamiwaza plugin status"
status_json="$tmpdir/kamiwaza-status.json"
run_json "openclaw kamiwaza status" "$status_json" "$OPENCLAW_CLI" kamiwaza status --json

jq -e '.hasPat == true' "$status_json" >/dev/null ||
  die "Kamiwaza PAT is not available to OpenClaw"

status_error="$(jq -r '.error // empty' "$status_json")"
if [[ -n "$status_error" ]]; then
  die "Kamiwaza status reported an error: $status_error"
fi

log "checking direct Kamiwaza tool catalog"
direct_tools_json="$tmpdir/kamiwaza-tools.json"
run_json "openclaw kamiwaza tools" "$direct_tools_json" "$OPENCLAW_CLI" kamiwaza tools --json
direct_count="$(jq '.tools | length' "$direct_tools_json")"
if [[ "$REQUIRE_TOOLS" == "1" && "$direct_count" == "0" ]]; then
  die "direct Kamiwaza catalog is empty"
fi
log "direct Kamiwaza tools: $direct_count"

locksmith_tools_json=""
if [[ "$CHECK_LOCKSMITH" == "1" ]]; then
  log "checking Locksmith upstream catalog"
  locksmith_tools_json="$tmpdir/locksmith-tools.json"
  locksmith_tools_err="$locksmith_tools_json.stderr"
  if ! "$OPENCLAW_CLI" locksmith tools --json >"$locksmith_tools_json" 2>"$locksmith_tools_err"; then
    if [[ "$REQUIRE_LOCKSMITH" == "1" ]]; then
      sed 's/^/  /' "$locksmith_tools_err" >&2
      die "openclaw locksmith tools failed"
    fi
    log "skipping Locksmith checks; openclaw locksmith tools failed"
    CHECK_LOCKSMITH=0
  elif ! jq . "$locksmith_tools_json" >/dev/null; then
    if [[ "$REQUIRE_LOCKSMITH" == "1" ]]; then
      die "openclaw locksmith tools did not emit valid JSON"
    fi
    log "skipping Locksmith checks; openclaw locksmith tools did not emit valid JSON"
    CHECK_LOCKSMITH=0
  fi

  if [[ "$CHECK_LOCKSMITH" == "1" ]]; then
    if [[ "$REQUIRE_LOCKSMITH" == "1" ]]; then
      jq -e '.serviceReachable == true' "$locksmith_tools_json" >/dev/null ||
        die "Locksmith service is not reachable"
    fi
    locksmith_kamiwaza_active="$(
      jq '[.tools[]? | select(.slug | startswith("kamiwaza_")) | select(.upstream == "active")] | length' \
        "$locksmith_tools_json"
    )"
    locksmith_kamiwaza_projected="$(
      jq '[.tools[]? | select(.slug | startswith("kamiwaza_")) | select(.configured == true)] | length' \
        "$locksmith_tools_json"
    )"
    if [[ "$direct_count" != "0" && "$REQUIRE_LOCKSMITH" == "1" && "$locksmith_kamiwaza_active" == "0" ]]; then
      die "direct Kamiwaza tools exist, but Locksmith does not list active Kamiwaza tools"
    fi
    log "Locksmith active Kamiwaza upstream tools: $locksmith_kamiwaza_active"
    log "Locksmith first-class Kamiwaza projections: $locksmith_kamiwaza_projected"
  fi
fi

if [[ "$CALL_TOOL" == "1" ]]; then
  [[ -n "$SMOKE_TOOL" ]] ||
    die "--call requires OPENCLAW_KAMIWAZA_SMOKE_TOOL"
  echo "$SMOKE_ARGS" | jq -e 'type == "object"' >/dev/null ||
    die "OPENCLAW_KAMIWAZA_SMOKE_ARGS must be a JSON object"

  log "calling direct Kamiwaza tool $SMOKE_TOOL"
  direct_call_json="$tmpdir/kamiwaza-call.json"
  run_json "openclaw kamiwaza call" "$direct_call_json" \
    "$OPENCLAW_CLI" kamiwaza call "$SMOKE_TOOL" --json "$SMOKE_ARGS" --agent-id "$SMOKE_AGENT_ID"
  jq -e --arg tool "$SMOKE_TOOL" '.tool == $tool and has("result")' "$direct_call_json" >/dev/null ||
    die "direct Kamiwaza call result did not match $SMOKE_TOOL"

  if [[ "$CHECK_LOCKSMITH" == "1" ]]; then
    log "calling Locksmith-proxied Kamiwaza tool $SMOKE_TOOL"
    locksmith_call_json="$tmpdir/locksmith-call.json"
    run_json "openclaw locksmith call" "$locksmith_call_json" \
      "$OPENCLAW_CLI" locksmith call "$SMOKE_TOOL" --method POST --json "$SMOKE_ARGS"
  fi
fi

log "smoke passed"
log "validated JSON summaries in a temporary workspace"
