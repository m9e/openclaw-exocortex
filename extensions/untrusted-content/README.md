# Untrusted Content Plugin

Optional OpenClaw guard plugin that sends selected tool output through the
local `exocortex-untrusted-content` dep checkout before that output reaches
agent context. That dep is intended to track upstream
[`AutoCodeGPT/tool-untrusted-content`](https://github.com/AutoCodeGPT/tool-untrusted-content).

This keeps the integration additive and upstream-merge-friendly:

- core only gains a generic `tool_result_transform` hook
- the untrusted-content policy stays plugin-owned
- the dep-owned Python service remains easy to iterate on without forking core

## What it does

- guards configured live tool results before they are returned to the agent
- defaults to guarding `web_fetch` and `browser`
- rewrites clean results with sanitized content
- quarantines risky results and replaces exposed content with a trusted summary
- registers an optional manual tool: `untrusted_content_scan`

The plugin expects a running `exocortex-untrusted-content` instance and does not try
to own its deployment lifecycle.

## Config

```json5
{
  plugins: {
    entries: {
      "untrusted-content": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:8787",
          toolNames: ["web_fetch", "browser"],
          trustLevel: "untrusted",
          timeoutSeconds: 10,
          maxContentChars: 50000,
          onError: "quarantine",
          sanitize: true,
          guardrail: true,
          scan: true,
        },
      },
    },
  },
  tools: {
    allow: ["untrusted_content_scan"],
  },
}
```

Environment fallback:

- `UNTRUSTED_CONTENT_BASE_URL`

## Behavior

- `web_fetch`-style `{ text: ... }` results are scanned and rewrapped as
  external content.
- `browser`-style `{ content: [...] }` results are scanned block-by-block for
  text content.
- If any browser text block is quarantined, the full exposed content list is
  replaced with a trusted quarantine summary.
- When `onError` is `pass`, guard service failures leave the original tool
  result untouched.
- When `onError` is `quarantine`, guard service failures replace exposed
  content with a quarantine summary.

## Local dev with the dep repo

If this workspace uses the standard `deps/` layout, use:

```bash
bash scripts/dev/run-untrusted-content-local.sh
```

That helper defaults to `../deps/exocortex-untrusted-content`, prefers `uv run`
when available, and otherwise falls back to `python3 -m untrusted_content_tool.cli`
with `PYTHONPATH=src`. Override `UNTRUSTED_CONTENT_REPO` if your checkout lives
elsewhere.
