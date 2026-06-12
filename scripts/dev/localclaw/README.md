# LOCALCLAW — trusted host-native claw

This directory builds **LOCALCLAW**: a trusted, host-native variant of the claw
harness. The OpenClaw gateway runs natively on the macOS host with full host
reach (shell, comms, fleet control, building Kamiwaza), and only the
untrusted-content guard service runs in a small disposable Lima VM.

## What this is

The other rig in this repo (`scripts/dev/lima/`) **contains the agent**: it runs
the gateway and tools inside a gateway/untrusted VM pair so a compromised agent
cannot reach the host directly. LOCALCLAW makes the opposite trade. The agent is
trusted and lives on the host; the thing we contain is **untrusted content**.
Raw, potentially hostile bytes from the web are parsed inside one throwaway VM,
and only a sanitized (or quarantined) result is allowed back to the host agent.

```
macOS host (trusted)                      localclaw-guard VM (disposable)
┌─────────────────────────────┐           ┌──────────────────────────────┐
│ OpenClaw gateway (launchd)  │  127.0.0.1│ untrusted-content service    │
│  agent: full host reach     │──:18787──▶│  sanitizer→guardrail→scanner │
│  guard plugin: fail-closed  │           │  no mounts*, no secrets      │
│ channels / clawctl / kz     │           │  (*dep repo RO only)         │
└─────────────────────────────┘           └──────────────────────────────┘
```

- Host gateway is the managed launchd install on `127.0.0.1:18789`.
- Guard forward is loopback-only, host `127.0.0.1:18787` → guest `127.0.0.1:8787`.
- The guard VM mounts exactly one path: the `deps/exocortex-untrusted-content`
  checkout, read-only. No host home, no workspace, no secrets.

## Threat model

We **contain the content, not the agent.** The agent is trusted to touch the
host; what is not trusted is anything a tool pulls in from outside (web pages,
search results, browser DOM). The `untrusted-content` guard plugin intercepts
the _results_ of those tools and runs them through the guard VM
(sanitizer → guardrail → scanner) before they reach agent context.

The guard is **load-bearing.** The plugin is configured with
`onError: "quarantine"`, which means fail-closed: if the guard VM is down, the
pipeline errors, or a stage classifier breaks, the guarded tool returns a
quarantine summary ("Original untrusted content was omitted") instead of the
raw payload. Guarded tools keep returning quarantine summaries until the guard
is healthy again. The inside-VM stage fallbacks are pinned the same way
(`UTC_GUARDRAIL_FALLBACK=quarantine`, `UTC_SCANNER_FALLBACK=quarantine`), so a
broken classifier fails closed instead of passing untrusted bytes through.

## Hard rules

- **Never route this claw's tools or model through the local Kamiwaza
  platform.** LOCALCLAW builds and tears down Kamiwaza; it must survive a
  `kzuat` teardown. The validated bring-up uses the external tokenator
  Kimi-K2.6 runtime, not a Kamiwaza-hosted model. Point the model at something
  that outlives the cluster.
- **Never join public or semi-public channels until a channel-ingest guard
  exists.** The guard plugin guards tool _results_, not inbound channel
  messages. An attacker who can DM the agent bypasses the content boundary
  entirely. Keep channels to trusted operators only.
- **Never add host mounts to the guard VM beyond the read-only dep repo.** That
  guest parses raw hostile bytes; mounting the host home or workspace defeats
  the entire boundary.
- **Two load-bearing dependencies must stay intact:**
  1. The bundled `untrusted-content` and `locksmith` plugins only register their
     hooks at gateway startup because their manifests declare
     `activation.onConfigPaths`
     (`extensions/untrusted-content/openclaw.plugin.json`,
     `extensions/locksmith/openclaw.plugin.json`). Without that, the
     `tool_result_transform` hook never registers and guarded tool output
     silently reaches the agent **unguarded**. If someone forks or strips the
     manifest, the guard goes dark — the fail-closed drill below is the canary
     that catches it.
  2. The plugin calls `POST /v1/pipelines/{id}/run`. The
     `deps/exocortex-untrusted-content` service originally served only
     `/v1/pipeline`; a compatibility route that speaks the plugin's protocol
     was added on the `localclaw-pipeline-route-compat` branch of that repo. The
     guard VM must run a build of the dep service that includes that route.

## Install

Turnkey, one command. It builds the guard VM, builds OpenClaw from this
checkout, writes config, installs the managed launchd gateway, and smoke-checks.

With the external tokenator Kimi-K2.6 model (the validated bring-up):

```bash
export LOCALCLAW_MODEL_API_KEY=...   # the model API key; written to ~/.openclaw/.env (0600), never printed
scripts/dev/localclaw/turnkey-local-claw.sh \
  --name localclaw \
  --workspace ~/claws/localclaw \
  --agent-name "Local Claw" \
  --model-base-url https://tokenator.example/v1 \
  --model-id kimi-k2.6 \
  --model-api-key-env LOCALCLAW_MODEL_API_KEY \
  --yes
```

Without a model here (configure a provider afterwards, e.g. Anthropic):

```bash
scripts/dev/localclaw/turnkey-local-claw.sh --name localclaw --workspace ~/claws/localclaw --yes
# then:
pnpm openclaw onboard
```

All flags: `--name` (default `localclaw`), `--workspace` (default
`~/claws/<name>`), `--guard-port` (default `18787`), `--agent-name`,
`--model-base-url`, `--model-id`, `--model-api-key-env` (default
`LOCALCLAW_MODEL_API_KEY`), `--yes`.

Or via clawctl (delegates to the same installer):

```bash
scripts/dev/lima/clawctl deploy --local --name localclaw --workspace ~/claws/localclaw --yes
```

## Operate

clawctl understands `kind=local` runtimes (identified by
`claw-runtime/<name>/metadata/localclaw.json`):

```bash
scripts/dev/lima/clawctl list
scripts/dev/lima/clawctl status --name localclaw
scripts/dev/lima/clawctl start  --name localclaw   # starts the guard VM only
scripts/dev/lima/clawctl stop   --name localclaw   # stops the guard VM only
scripts/dev/lima/clawctl shell  --name localclaw   # lands in the guard VM
```

Note the asymmetry: `clawctl start/stop --name <n>` cycles **the guard VM**. The
host gateway is **shared and singular** (one launchd-managed gateway on the
host, not one per runtime), so manage it directly:

```bash
pnpm openclaw gateway start
pnpm openclaw gateway stop
pnpm openclaw gateway status --deep
```

`clawctl shell --name <n>` lands you in the guard VM (there is no gateway VM to
shell into). An explicit `clawctl shell --name <n> gateway` is an error.

Logs:

- Gateway: `~/Library/Logs/openclaw/gateway.log`
- Guard service (inside the VM):
  ```bash
  LIMA_HOME=<workspace-root>/claw-runtime/<name>/lima \
    limactl shell <name>-guard -- sudo journalctl -u untrusted-content
  ```

## The fail-closed drill

Run this periodically as a canary. It proves the guard plugin is still
registered and still failing closed — i.e. that the activation manifest and the
guard VM path are both intact.

```bash
# 1. take the guard offline
LIMA_HOME=<workspace>/claw-runtime/localclaw/lima limactl stop localclaw-guard

# 2. via the agent: run a guarded web_fetch against any URL
#    EXPECT a quarantine summary ("Original untrusted content was omitted"),
#    NOT the raw page text. If you get raw page text, the guard is NOT in the
#    path — investigate the activation manifest before trusting this claw.

# 3. restore the guard
LIMA_HOME=<workspace>/claw-runtime/localclaw/lima limactl start localclaw-guard

# 4. re-run the same web_fetch: a clean page should now pass through.
```

(`<workspace>` here is the workspace **root** that contains `claw-runtime/`,
i.e. `/Users/yod/code/exocortex`.)

## Switching to LLM-backed scanning

The guard defaults to a heuristic guardrail and scanner. To use LLM-backed
classification, re-run the guard creator with the `UTC_*` env passthrough. The
editable install plus systemd restart picks up the new env on re-run:

```bash
UTC_GUARDRAIL_MODE=openai \
UTC_GUARDRAIL_ENDPOINT=https://.../v1 \
UTC_GUARDRAIL_MODEL=... \
UTC_GUARDRAIL_API_KEY=... \
UTC_SCANNER_MODE=openai \
UTC_SCANNER_ENDPOINT=https://.../v1 \
UTC_SCANNER_MODEL=... \
UTC_SCANNER_API_KEY=... \
  scripts/dev/localclaw/create-guard-vm.sh --name localclaw --guard-port 18787
```

The fail-closed fallbacks stay pinned to `quarantine` regardless of mode, so an
LLM endpoint outage still fails closed.

## Follow-ups (out of scope today)

- **Channel-ingest guarding** — guard inbound channel messages, not just tool
  results, so the agent can safely take public/semi-public traffic.
- **VM-side fetching/browsing** — perform the fetch/browse inside the guard VM
  so raw bytes never touch the host at all, not just the parse step.
- **Guard-VM egress PF tightening** — restrict the guard VM's outbound network
  the way the VM-pair rig restricts the untrusted guest.
- **Honeypot wiring** — route the dep service's `/v1/honeypot/trigger` events
  into incident handling.
- **Optional host Locksmith sidecar** — a host-side Locksmith proxy so
  `locksmith_*` tools inject credentials without exposing them to the agent
  (already in the guard's `toolNames` so its results are guarded).
