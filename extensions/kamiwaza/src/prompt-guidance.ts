import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { KamiwazaError, discoverKamiwazaTools } from "./client.js";
import { resolveKamiwazaPromptCatalogEnabled } from "./config.js";

const STATIC_GUIDANCE = [
  "The optional `kamiwaza_call` tool is a direct bridge to Kamiwaza MCP tools.",
  "Use it when Kamiwaza is available and Agent Locksmith is not in the path.",
  "Do not send Kamiwaza PATs, Authorization headers, or raw API keys in tool params. OpenClaw supplies the configured PAT.",
  "The `tool` param selects a discovered Kamiwaza tool slug, and `arguments` is the JSON object passed to that MCP tool.",
].join("\n");

export function buildKamiwazaStaticPromptGuidance(): string {
  return STATIC_GUIDANCE;
}

export async function buildKamiwazaDynamicCatalogGuidance(
  cfg?: OpenClawConfig,
): Promise<string | undefined> {
  if (!resolveKamiwazaPromptCatalogEnabled(cfg)) {
    return undefined;
  }
  try {
    const tools = await discoverKamiwazaTools(cfg);
    if (tools.length === 0) {
      return "No Kamiwaza MCP tools are currently active.";
    }
    const lines = tools.map((tool) => {
      const description = tool.description?.trim();
      return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
    });
    return `Currently discovered Kamiwaza MCP tools:\n${lines.join("\n")}`;
  } catch (error) {
    if (error instanceof KamiwazaError && error.code === "missing-token") {
      return [
        "Kamiwaza is enabled, but no PAT is available.",
        "Configure `plugins.entries.kamiwaza.config.apiToken`, set `KAMIWAZA_API_KEY`, or sync the local Kamiwaza PAT store before calling `kamiwaza_call`.",
      ].join("\n");
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Kamiwaza tool discovery is currently unavailable: ${message}`;
  }
}
