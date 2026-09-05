import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { KamiwazaError, callKamiwazaTool, discoverKamiwazaTools } from "./client.js";
import {
  resolveKamiwazaApiToken,
  resolveKamiwazaApiUrlCandidates,
  resolveKamiwazaCredentialStorePath,
} from "./config.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(key: string, value: string): void {
  process.stdout.write(`${key}: ${value}\n`);
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function registerKamiwazaCli(program: Command, cfg?: OpenClawConfig): void {
  const kamiwaza = program
    .command("kamiwaza")
    .description("Inspect and call direct Kamiwaza MCP tools");

  kamiwaza
    .command("status")
    .description("Show direct Kamiwaza plugin connectivity and credential state")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      let tools: Awaited<ReturnType<typeof discoverKamiwazaTools>> | undefined;
      let error: string | undefined;
      try {
        tools = await discoverKamiwazaTools(cfg);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const payload = {
        apiUrlCandidates: resolveKamiwazaApiUrlCandidates(cfg),
        credentialStorePath: resolveKamiwazaCredentialStorePath(cfg),
        hasPat: Boolean(resolveKamiwazaApiToken(cfg)),
        toolCount: tools?.length ?? 0,
        ...(error ? { error } : {}),
      };
      if (options.json) {
        printJson(payload);
        return;
      }
      writeLine("Kamiwaza API candidates", payload.apiUrlCandidates.join(", "));
      writeLine("credential store", payload.credentialStorePath);
      writeLine("PAT available", payload.hasPat ? "yes" : "no");
      writeLine("tools", String(payload.toolCount));
      if (error) {
        writeError(`error: ${error}`);
      }
    });

  kamiwaza
    .command("tools")
    .description("List discovered Kamiwaza MCP tools")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const tools = await discoverKamiwazaTools(cfg);
        if (options.json) {
          printJson({ tools });
          return;
        }
        if (tools.length === 0) {
          process.stdout.write("(none)\n");
          return;
        }
        for (const tool of tools) {
          const desc = tool.description ? `: ${tool.description}` : "";
          process.stdout.write(`- ${tool.name}${desc}\n`);
        }
      } catch (error) {
        writeError(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  kamiwaza
    .command("call <tool>")
    .description("Call a Kamiwaza MCP tool with JSON arguments")
    .option("--json <json>", "JSON object arguments", "{}")
    .option("--agent-id <id>", "Delegated agent identity subject for signed calls")
    .option("--session-id <id>", "Optional session id to include in delegated identity claims")
    .action(
      async (tool: string, options: { agentId?: string; json?: string; sessionId?: string }) => {
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(options.json ?? "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("JSON value must be an object");
          }
          // SAFETY: The preceding check rejects null, arrays, and non-object JSON values.
          args = parsed as Record<string, unknown>;
        } catch (error) {
          writeError(
            `--json must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
          return;
        }
        try {
          printJson(
            await callKamiwazaTool({
              cfg,
              tool,
              arguments: args,
              agentId: options.agentId,
              sessionId: options.sessionId,
            }),
          );
        } catch (error) {
          if (error instanceof KamiwazaError) {
            writeError(`error: ${error.code}: ${error.message}`);
          } else {
            writeError(`error: ${error instanceof Error ? error.message : String(error)}`);
          }
          process.exitCode = 1;
        }
      },
    );
}
