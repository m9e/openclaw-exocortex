---
summary: "Run OpenClaw with kzproxy (OpenAI-compatible local gateway)"
read_when:
  - You want OpenClaw to use a local kzproxy /v1 gateway
  - You want the model picker to reflect kzproxy /v1/models dynamically
title: "kzproxy"
---

kzproxy exposes a local OpenAI-compatible `/v1` gateway, commonly backed by
LiteLLM routing. OpenClaw connects to it with the `openai-completions` API and
can auto-discover available models from `/v1/models`.

| Property         | Value                                    |
| ---------------- | ---------------------------------------- |
| Provider ID      | `kzproxy`                                |
| Plugin           | bundled, `enabledByDefault: true`        |
| API              | `openai-completions` (OpenAI-compatible) |
| Auth env var     | `KZPROXY_API_KEY`                        |
| Default base URL | `http://127.0.0.1:4000/v1`               |

## Dynamic model discovery

When `KZPROXY_API_KEY` is set, or the configured provider uses a non-secret
marker such as `not-required`, OpenClaw can query:

```bash
GET http://127.0.0.1:4000/v1/models
```

If you set `models.providers.kzproxy` explicitly, add `"kzproxy/*": {}` to
`agents.defaults.models` when you want the visible catalog to be refreshed from
the configured endpoint instead of a static model list.

```json5
{
  models: {
    providers: {
      kzproxy: {
        baseUrl: "http://127.0.0.1:4000/v1",
        apiKey: "not-required",
        api: "openai-completions",
        models: [],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "kzproxy/small-fast" },
      models: {
        "kzproxy/*": {},
      },
    },
  },
}
```

Use a real `KZPROXY_API_KEY` if your kzproxy endpoint enforces bearer auth.
