import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { listLocksmithTools } from "./client.js";
import { resolveLocksmithBaseUrl, resolveLocksmithPromptCatalogEnabled } from "./config.js";

const BASE_GUIDANCE = [
  "The optional `locksmith_call` tool is a bridge to Agent Locksmith, a credential-injecting proxy.",
  "Use it when you need an external API that has been exposed through Locksmith.",
  "Do not send Authorization headers or raw API keys in tool params. Locksmith injects upstream credentials for the configured tool.",
  "The `tool` param selects the Locksmith tool slug, and `path` is the remaining upstream-relative path under that tool.",
].join("\n");

export async function buildLocksmithPromptGuidance(
  cfg?: OpenClawConfig,
): Promise<string | undefined> {
  if (!resolveLocksmithPromptCatalogEnabled(cfg)) {
    return BASE_GUIDANCE;
  }

  try {
    const tools = await listLocksmithTools(cfg);
    if (tools.length === 0) {
      return `${BASE_GUIDANCE}\nNo Locksmith tools are currently active at ${resolveLocksmithBaseUrl(cfg)}.`;
    }
    const lines = tools.map((tool) => {
      const description = tool.description?.trim();
      return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
    });
    return `${BASE_GUIDANCE}\nCurrently discovered Locksmith tools:\n${lines.join("\n")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${BASE_GUIDANCE}\nLocksmith discovery is currently unavailable: ${message}`;
  }
}
