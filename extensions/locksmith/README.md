# Locksmith Plugin

Optional OpenClaw plugin that bridges the local `exocortex-agent-locksmith`
dep checkout into an agent-facing `locksmith_call` tool and a small operator
CLI. That dep is intended to track upstream
[`SentientSwarm/agent-locksmith`](https://github.com/SentientSwarm/agent-locksmith).

This keeps the integration additive:

- no core OpenClaw egress or tool-routing rewrites
- no vendored Rust code in the OpenClaw repo
- compatible with [openclaw-hardened](https://github.com/SentientSwarm/openclaw-hardened),
  which already deploys Locksmith as a sidecar instead of forking OpenClaw

## What it does

- registers optional tool `locksmith_call`
- injects discovery-backed prompt guidance from `GET /tools`
- exposes `openclaw locksmith status` and `openclaw locksmith tools`

The plugin expects a running Locksmith instance and does not try to own its
deployment lifecycle.

## Config

```json5
{
  plugins: {
    entries: {
      locksmith: {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:9200",
          inboundToken: { ref: "env:LOCKSMITH_INBOUND_TOKEN" },
          catalogTtlSeconds: 30,
          timeoutSeconds: 30,
          maxResponseBytes: 262144,
          promptCatalog: true,
        },
      },
    },
  },
  tools: {
    allow: ["locksmith_call"],
  },
}
```

Environment fallbacks:

- `LOCKSMITH_BASE_URL`
- `LOCKSMITH_INBOUND_TOKEN`

## Local dev with the sibling repo

If this workspace uses the standard `deps/` layout, use:

```bash
bash scripts/dev/run-locksmith-local.sh
```

That helper builds `../deps/exocortex-agent-locksmith` by default and runs it
with the example config at `extensions/locksmith/examples/local.locksmith.yaml`.
Override `LOCKSMITH_REPO` if your checkout lives elsewhere.

## Hardened deployments

`openclaw-hardened` remains the right place to deploy Locksmith, Pipelock,
LlamaFirewall, and nftables as system services. This plugin is the light-touch
OpenClaw-side consumer surface for that stack.
