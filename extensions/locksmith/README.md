# Locksmith Plugin

OpenClaw plugin that bridges the local `exocortex-agent-locksmith` dep checkout
into agent-facing Locksmith tools and a small operator CLI. That dep is intended
to track upstream
[`SentientSwarm/agent-locksmith`](https://github.com/SentientSwarm/agent-locksmith).

This keeps the integration additive:

- no core OpenClaw egress or tool-routing rewrites
- no vendored Rust code in the OpenClaw repo
- compatible with [openclaw-hardened](https://github.com/SentientSwarm/openclaw-hardened),
  which already deploys Locksmith as a sidecar instead of forking OpenClaw

## What it does

- registers optional generic tool `locksmith_call` when `genericTool` is not false
- registers projected `locksmith_<slug>` tools from the configured allowlist
- injects prompt guidance for configured or discovered Locksmith tools
- exposes `openclaw locksmith status` and `openclaw locksmith tools`

The plugin expects a running Locksmith instance and does not try to own its
deployment lifecycle.

The bundled plugin is disabled by default. Enable it before using the
top-level CLI command:

```bash
openclaw plugins enable locksmith
openclaw gateway restart
openclaw locksmith status
```

## Config

```json5
{
  plugins: {
    entries: {
      locksmith: {
        enabled: true,
        config: {
          required: true,
          genericTool: false,
          baseUrl: "http://127.0.0.1:9200",
          inboundToken: { ref: "env:LOCKSMITH_INBOUND_TOKEN" },
          catalogTtlSeconds: 30,
          timeoutSeconds: 30,
          maxResponseBytes: 262144,
          promptCatalog: true,
          tools: {
            github: {
              enabled: true,
              description: "GitHub REST API exposed through Locksmith",
            },
          },
        },
      },
    },
  },
  tools: {
    fs: { workspaceOnly: true },
    exec: { security: "deny" },
    allow: [
      "read",
      "write",
      "edit",
      "apply_patch",
      "memory_search",
      "memory_get",
      "session_status",
      "update_plan",
      "locksmith_github",
    ],
    alsoAllow: ["locksmith_github"],
    deny: [
      "group:runtime",
      "group:web",
      "group:ui",
      "group:messaging",
      "group:automation",
      "group:nodes",
      "group:media",
      "agents_list",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
      "locksmith_call",
    ],
  },
}
```

When `required` is true, gateway startup fails closed unless the plugin is
enabled, `genericTool` is false, an inbound bearer token is configured,
unauthenticated `GET /tools` is rejected by Locksmith, authenticated `GET
/tools` succeeds, and every projected tool is active on the sidecar.

The `tools` policy in the example is the secure gateway posture: keep
workspace-local editing and projected Locksmith tools, but remove direct shell,
process, browser/web, messaging, media, session-spawn, and node-control tools
that could bypass the sidecar.

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
