import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { listLocksmithTools, sortLocksmithTools } from "./client.js";
import {
  resolveLocksmithBaseUrl,
  resolveLocksmithGenericToolEnabled,
  resolveLocksmithProjectedTools,
  resolveLocksmithPromptCatalogEnabled,
} from "./config.js";

const BRIDGE_GUIDANCE = [
  "The optional `locksmith_call` tool is a bridge to Agent Locksmith, a credential-injecting proxy.",
  "Use it when you need an external API that has been exposed through Locksmith.",
  "Do not send Authorization headers or raw API keys in tool params. Locksmith injects upstream credentials for the configured tool.",
  "The `tool` param selects the Locksmith tool slug, and `path` is the remaining upstream-relative path under that tool.",
].join("\n");

const PROJECTED_GUIDANCE = [
  "Each `locksmith_<slug>` tool calls the matching Agent Locksmith tool slug; Locksmith injects upstream credentials.",
  "Do not send Authorization headers or raw API keys in tool params.",
  "The `path` param is the relative path under that tool; the slug is already bound by the tool name.",
].join("\n");

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
  return `${PROJECTED_GUIDANCE}\nProjected Locksmith tools:\n${lines.join("\n")}`;
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
