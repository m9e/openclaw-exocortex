import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { fetchLocksmithHealth, listLocksmithTools } from "./client.js";
import { resolveLocksmithBaseUrl } from "./config.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function registerLocksmithCli(program: Command, cfg?: OpenClawConfig): void {
  const locksmith = program
    .command("locksmith")
    .description("Inspect the configured Agent Locksmith service");

  locksmith
    .command("status")
    .description("Show Locksmith health and basic connectivity")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const health = await fetchLocksmithHealth(cfg);
      const payload = {
        baseUrl: resolveLocksmithBaseUrl(cfg),
        ...health,
      };
      if (options.json) {
        printJson(payload);
        return;
      }
      process.stdout.write(`Locksmith: ${payload.baseUrl}\n`);
      process.stdout.write(`status: ${payload.status ?? "unknown"}\n`);
      process.stdout.write(`version: ${payload.version ?? "unknown"}\n`);
      process.stdout.write(`tools: ${(payload.tools ?? []).join(", ") || "(none)"}\n`);
    });

  locksmith
    .command("tools")
    .description("List active Locksmith tools from GET /tools")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const tools = await listLocksmithTools(cfg);
      if (options.json) {
        printJson({ baseUrl: resolveLocksmithBaseUrl(cfg), tools });
        return;
      }
      process.stdout.write(`Locksmith tools from ${resolveLocksmithBaseUrl(cfg)}\n`);
      if (tools.length === 0) {
        process.stdout.write("(none)\n");
        return;
      }
      for (const tool of tools) {
        process.stdout.write(`- ${tool.name}${tool.description ? `: ${tool.description}` : ""}\n`);
      }
    });
}
