import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { listLocksmithTools, sortLocksmithTools } from "./client.js";
import {
  type LocksmithProjectedTool,
  resolveLocksmithBaseUrl,
  resolveLocksmithGenericToolEnabled,
  resolveLocksmithProjectedTools,
  resolveLocksmithPromptCatalogEnabled,
} from "./config.js";

const BRIDGE_GUIDANCE = [
  "The optional `locksmith_call` tool is a bridge to Agent Locksmith, a credential-injecting proxy.",
  "Call `locksmith_call` directly when you need an external API that has been exposed through Locksmith.",
  "Do not use web_fetch, curl, fetch, or another HTTP client to probe or call Locksmith routes.",
  "Do not send Authorization headers, bearer tokens, or raw API keys in tool params. Locksmith injects upstream credentials for the configured tool.",
  "After calling Locksmith, wait for the returned tool result and report success only from the returned status/data.",
  "The `tool` param selects the Locksmith tool slug, and `path` is the remaining upstream-relative path under that tool.",
  "Parameters: `tool`, `path`, `method` (default GET), `query`, `headers` (non-auth only), `json` or `body`, plus optional `timeoutSeconds` and `maxResponseBytes`.",
  'Example call shape: `locksmith_call` with `{ "tool": "github", "method": "GET", "path": "user/repos", "query": { "per_page": 10 } }`.',
].join("\n");

const PROJECTED_GUIDANCE = [
  "Each `locksmith_<slug>` tool is the complete entry point for the matching Agent Locksmith tool slug; call it directly.",
  "Locksmith injects upstream credentials and forwards the request. Do not handle upstream auth yourself.",
  "Do not use web_fetch, curl, fetch, or another HTTP client to probe or call Locksmith routes.",
  "Do not probe paths like `/<slug>`, `/proxy/<slug>`, or `/api/<slug>`; use the projected `locksmith_<slug>` tool only.",
  "Do not inspect Locksmith YAML `tools: []` blocks to decide whether a projected tool exists; active registrations can come from the Locksmith admin catalog/DB.",
  "Do not send Authorization headers, bearer tokens, or raw API keys in tool params. Authorization-style headers are ignored.",
  "After calling a projected Locksmith tool, wait for the returned tool result and report success only from the returned status/data.",
  "Proxy-mode parameters: `path` (upstream-relative; do not prefix `/api/<slug>/`), `method` (default GET), `query`, `headers` (non-auth only), `json` or `body`, plus optional `timeoutSeconds` and `maxResponseBytes`.",
  'Generic proxy call shape: `{ "method": "GET", "path": "relative/path", "query": { "per_page": 10 } }`.',
].join("\n");

function buildProjectedUsageExamples(projected: LocksmithProjectedTool[]): string | undefined {
  const hasProxyMode = projected.some((entry) => entry.mode === "proxy");
  if (!hasProxyMode) {
    return undefined;
  }
  const lines = [
    "Projected Locksmith proxy examples:",
    '- Generic REST read: `{ "method": "GET", "path": "resource/path" }`.',
  ];
  if (projected.some((entry) => entry.slug === "github")) {
    lines.push(
      '- `locksmith_github` authenticated user: `{ "method": "GET", "path": "user" }`.',
      '- `locksmith_github` list repositories: `{ "method": "GET", "path": "user/repos", "query": { "type": "owner", "sort": "updated" } }`.',
      '- `locksmith_github` create repository: `{ "method": "POST", "path": "user/repos", "json": { "name": "repo-name", "private": true } }`.',
    );
  }
  return lines.join("\n");
}

/**
 * Build cache-stable guidance for `prependSystemContext`.
 *
 * Only config-derived text may live here: it lands above the prompt-cache
 * boundary, so anything dynamic (live `/tools` listings, service health,
 * error messages) MUST go through {@link buildLocksmithDynamicCatalogGuidance}
 * instead. See plan §5 (prompt-cache stability).
 */
export function buildLocksmithStaticPromptGuidance(cfg?: OpenClawConfig): string {
  const projected = resolveLocksmithProjectedTools(cfg);
  if (projected.length === 0) {
    return resolveLocksmithGenericToolEnabled(cfg)
      ? BRIDGE_GUIDANCE
      : "Agent Locksmith is required, but no projected Locksmith tools are configured.";
  }
  // Slugs are already sorted deterministically by resolveLocksmithProjectedTools().
  const lines = projected.map((entry) => {
    const description = entry.description?.trim();
    return description ? `- ${entry.toolName}: ${description}` : `- ${entry.toolName}`;
  });
  const examples = buildProjectedUsageExamples(projected);
  return [PROJECTED_GUIDANCE, `Projected Locksmith tools:\n${lines.join("\n")}`, examples]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/**
 * Build dynamic catalog guidance for `appendSystemContext`.
 *
 * Lives below the cached prefix, so live service state, errors, and TTL-driven
 * catalog refreshes can change here without invalidating the prompt cache.
 * When projected tools are configured, this still checks live Locksmith state
 * below the cache boundary and warns about active tools that have not been
 * projected as first-class OpenClaw tools.
 */
export async function buildLocksmithDynamicCatalogGuidance(
  cfg?: OpenClawConfig,
): Promise<string | undefined> {
  if (!resolveLocksmithPromptCatalogEnabled(cfg)) {
    return undefined;
  }
  try {
    const tools = sortLocksmithTools(await listLocksmithTools(cfg));
    const projected = resolveLocksmithProjectedTools(cfg);
    if (projected.length > 0) {
      const projectedSlugs = new Set(projected.map((entry) => entry.slug));
      const unprojected = tools.filter((tool) => !projectedSlugs.has(tool.name));
      if (unprojected.length === 0) {
        return undefined;
      }
      const lines = unprojected.map((tool) => {
        const description = tool.description?.trim();
        return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
      });
      const bridgeGuidance = resolveLocksmithGenericToolEnabled(cfg)
        ? "They are callable through `locksmith_call` now, but first-class OpenClaw tool names require updating the Locksmith tool projection config and restarting the gateway."
        : "Update the Locksmith tool projection config and restart the OpenClaw gateway to expose them as first-class tools.";
      return `Locksmith has active tools that are not projected as first-class OpenClaw tools:\n${lines.join("\n")}\n${bridgeGuidance}`;
    }
    if (tools.length === 0) {
      return `No Locksmith tools are currently active at ${resolveLocksmithBaseUrl(cfg)}.`;
    }
    const lines = tools.map((tool) => {
      const description = tool.description?.trim();
      return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
    });
    return `Currently discovered Locksmith tools:\n${lines.join("\n")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Locksmith discovery is currently unavailable: ${message}`;
  }
}
