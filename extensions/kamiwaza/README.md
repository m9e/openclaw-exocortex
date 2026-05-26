# Kamiwaza Plugin

Bundled OpenClaw plugin for direct Kamiwaza MCP tool access when the local
Kamiwaza platform is available and Agent Locksmith is not in the path.

This is a fallback bridge. Prefer Locksmith for credential-proxy deployments;
use this plugin when OpenClaw needs to reach Kamiwaza tools directly.

## Tools

- `kamiwaza_call`: discovers the current Kamiwaza MCP catalog and invokes the
  selected tool slug with JSON arguments.

The plugin does not expose the configured PAT to the agent. If
`delegation.signingSecret` or `KAMIWAZA_DELEGATION_SIGNING_SECRET` is present,
tool calls also carry a short-lived signed delegated identity header.

## Config

```json5
{
  plugins: {
    entries: {
      kamiwaza: {
        enabled: true,
        config: {
          apiUrl: "https://host.lima.internal/api",
          apiToken: { ref: "env:KAMIWAZA_API_KEY" },
          credentialStorePath: "~/.openclaw/credentials/kamiwaza-pat-store.json",
          genericTool: true,
          promptCatalog: true,
          verifyTls: false,
          delegation: {
            enabled: true,
            required: false,
            signingSecret: { ref: "env:KAMIWAZA_DELEGATION_SIGNING_SECRET" },
          },
        },
      },
    },
  },
}
```

PAT resolution order:

1. `plugins.entries.kamiwaza.config.apiToken`
2. `KAMIWAZA_API_KEY`
3. `~/.openclaw/credentials/kamiwaza-pat-store.json`

The credential store can be either the normalized secret file produced by the
workspace `sync-kamiwaza-pat-credentials.sh` helper or the raw
`pdash-pat-store-v1` export from `KAMIWAZA_PAT_STORE_PATH`. When the API URL is
a local bridge host such as `127.0.0.1` or `host.lima.internal`, set
`credentialHost` to the actual Kamiwaza host key in the PAT store.

For CLI-only tool calls in a config where `delegation.required` is true, pass an
explicit smoke/admin identity:

```bash
openclaw kamiwaza call kamiwaza_tool_z_19607be6_search \
  --agent-id openclaw-smoke \
  --json '{"query":"openclaw"}'
```
