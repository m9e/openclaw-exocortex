import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  callLocksmith,
  fetchLocksmithAdmin,
  fetchLocksmithHealth,
  listLocksmithTools,
  LocksmithError,
  sortLocksmithTools,
  type LocksmithDiscoveredTool,
} from "./client.js";
import {
  resolveLocksmithBaseUrl,
  resolveLocksmithProjectedTools,
  type LocksmithProjectedTool,
} from "./config.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

type ToolRow = {
  slug: string;
  configured: boolean;
  projectedAs?: string;
  upstream: "active" | "absent" | "disabled" | "unknown";
  description?: string;
};

function buildToolRows(
  projected: LocksmithProjectedTool[],
  discovered: LocksmithDiscoveredTool[] | undefined,
): ToolRow[] {
  const slugs = new Map<string, ToolRow>();
  for (const entry of projected) {
    slugs.set(entry.slug, {
      slug: entry.slug,
      configured: true,
      projectedAs: entry.toolName,
      upstream: discovered === undefined ? "unknown" : "absent",
      description: entry.description,
    });
  }
  if (discovered) {
    for (const tool of discovered) {
      const existing = slugs.get(tool.name);
      if (existing) {
        existing.upstream = "active";
        if (!existing.description) {
          existing.description = tool.description;
        }
      } else {
        slugs.set(tool.name, {
          slug: tool.name,
          configured: false,
          upstream: "active",
          description: tool.description,
        });
      }
    }
  }
  return [...slugs.values()].toSorted((a, b) =>
    a.slug.toLowerCase() < b.slug.toLowerCase()
      ? -1
      : a.slug.toLowerCase() > b.slug.toLowerCase()
        ? 1
        : 0,
  );
}

async function fetchDiscoveredOrUndefined(
  cfg?: OpenClawConfig,
): Promise<LocksmithDiscoveredTool[] | undefined> {
  try {
    return sortLocksmithTools(await listLocksmithTools(cfg));
  } catch {
    return undefined;
  }
}

function writeKeyValueLine(stream: NodeJS.WritableStream, key: string, value: string): void {
  stream.write(`${key}: ${value}\n`);
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Build the proposed JSON patch for `plugins.entries.locksmith.config.tools.<slug>`.
 *
 * Returns a structure-preserving merge of the current `tools.*` entry with
 * `enabled: patch.enabled`. The CLI prints this so an operator (or
 * automation) can apply it via `openclaw config set` or their config tool.
 */
type ExistingToolsMap = Record<string, Record<string, unknown>>;

function readCurrentToolsBlock(cfg?: OpenClawConfig): ExistingToolsMap {
  const pluginConfig = cfg?.plugins?.entries?.locksmith?.config as
    | { tools?: ExistingToolsMap }
    | undefined;
  return pluginConfig?.tools ?? {};
}

function buildToolEnablementPatch(
  currentTools: ExistingToolsMap,
  slug: string,
  enabled: boolean,
): { path: string; tools: ExistingToolsMap } {
  const existing = currentTools[slug] ?? {};
  const tools: ExistingToolsMap = {
    ...currentTools,
    [slug]: { ...existing, enabled },
  };
  return { path: "plugins.entries.locksmith.config.tools", tools };
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
      const projected = resolveLocksmithProjectedTools(cfg);
      let healthError: string | undefined;
      let health: Awaited<ReturnType<typeof fetchLocksmithHealth>> | undefined;
      try {
        health = await fetchLocksmithHealth(cfg);
      } catch (error) {
        healthError = error instanceof Error ? error.message : String(error);
      }
      const payload = {
        baseUrl: resolveLocksmithBaseUrl(cfg),
        projectedTools: projected.map((entry) => entry.toolName),
        ...health,
        ...(healthError ? { error: healthError } : {}),
      };
      if (options.json) {
        printJson(payload);
        return;
      }
      writeKeyValueLine(process.stdout, "Locksmith", payload.baseUrl);
      writeKeyValueLine(
        process.stdout,
        "status",
        health?.status ?? (healthError ? "unreachable" : "unknown"),
      );
      writeKeyValueLine(process.stdout, "version", health?.version ?? "unknown");
      writeKeyValueLine(process.stdout, "tools", (health?.tools ?? []).join(", ") || "(none)");
      writeKeyValueLine(
        process.stdout,
        "projected",
        projected.map((entry) => entry.toolName).join(", ") || "(none)",
      );
      if (healthError) {
        writeError(`error: ${healthError}`);
      }
    });

  locksmith
    .command("tools")
    .description("List Locksmith tools (configured projection + upstream catalog)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const projected = resolveLocksmithProjectedTools(cfg);
      const discovered = await fetchDiscoveredOrUndefined(cfg);
      const rows = buildToolRows(projected, discovered);
      if (options.json) {
        printJson({
          baseUrl: resolveLocksmithBaseUrl(cfg),
          serviceReachable: discovered !== undefined,
          tools: rows,
        });
        return;
      }
      process.stdout.write(`Locksmith tools at ${resolveLocksmithBaseUrl(cfg)}\n`);
      if (discovered === undefined) {
        process.stdout.write("(service unreachable; showing configured projection only)\n");
      }
      if (rows.length === 0) {
        process.stdout.write("(none)\n");
        return;
      }
      for (const row of rows) {
        const flags = [
          row.configured ? "configured" : "upstream-only",
          row.projectedAs ? `→ ${row.projectedAs}` : undefined,
          `upstream=${row.upstream}`,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" ");
        const desc = row.description ? `: ${row.description}` : "";
        process.stdout.write(`- ${row.slug} [${flags}]${desc}\n`);
      }
    });

  locksmith
    .command("describe <slug>")
    .description("Show details for a single Locksmith tool")
    .option("--json", "Print machine-readable JSON")
    .action(async (slug: string, options: { json?: boolean }) => {
      const projected = resolveLocksmithProjectedTools(cfg);
      const discovered = await fetchDiscoveredOrUndefined(cfg);
      const rows = buildToolRows(projected, discovered);
      const row = rows.find((entry) => entry.slug === slug.toLowerCase());
      if (!row) {
        writeError(`No Locksmith tool matches slug "${slug}".`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        printJson({ baseUrl: resolveLocksmithBaseUrl(cfg), tool: row });
        return;
      }
      writeKeyValueLine(process.stdout, "slug", row.slug);
      writeKeyValueLine(process.stdout, "configured", row.configured ? "yes" : "no");
      writeKeyValueLine(process.stdout, "projected as", row.projectedAs ?? "(none)");
      writeKeyValueLine(process.stdout, "upstream", row.upstream);
      if (row.description) {
        writeKeyValueLine(process.stdout, "description", row.description);
      }
    });

  locksmith
    .command("enable <slug>")
    .description("Enable the OpenClaw projection of a Locksmith tool (config edit)")
    .action((slug: string) => {
      const normalized = slug.toLowerCase();
      const proposal = buildToolEnablementPatch(readCurrentToolsBlock(cfg), normalized, true);
      printJson({ ...proposal, slug: normalized, enabled: true });
      writeError(
        "note: this command emits the proposed config patch; persist with `openclaw config set` or your config-management tool.",
      );
    });

  locksmith
    .command("disable <slug>")
    .description("Disable the OpenClaw projection of a Locksmith tool (config edit)")
    .action((slug: string) => {
      const normalized = slug.toLowerCase();
      const proposal = buildToolEnablementPatch(readCurrentToolsBlock(cfg), normalized, false);
      printJson({ ...proposal, slug: normalized, enabled: false });
      writeError(
        "note: this command emits the proposed config patch; persist with `openclaw config set` or your config-management tool.",
      );
    });

  locksmith
    .command("call <slug> [path]")
    .description("Human passthrough call against a Locksmith tool, with credential injection")
    .option("--method <method>", "HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD)", "GET")
    .option("--json <json>", "Send a JSON body (provided as a JSON-encoded string)")
    .option(
      "--user <user>",
      "Override X-Locksmith-User (defaults to operator login when invoked from agent)",
    )
    .action(
      async (
        slug: string,
        path: string | undefined,
        options: { method?: string; json?: string; user?: string },
      ) => {
        let json: unknown;
        if (options.json !== undefined) {
          try {
            json = JSON.parse(options.json);
          } catch (error) {
            writeError(
              `--json must be a valid JSON-encoded string: ${error instanceof Error ? error.message : String(error)}`,
            );
            process.exitCode = 1;
            return;
          }
        }
        try {
          const result = await callLocksmith({
            cfg,
            tool: slug.toLowerCase(),
            user: options.user,
            method: options.method,
            path,
            json,
          });
          printJson(result);
        } catch (error) {
          if (error instanceof LocksmithError) {
            writeError(`error: ${error.code}: ${error.message}`);
          } else {
            writeError(`error: ${error instanceof Error ? error.message : String(error)}`);
          }
          process.exitCode = 1;
        }
      },
    );

  locksmith
    .command("audit")
    .description("Read recent audit events from Locksmith /admin/audit (requires admin token)")
    .option("--limit <n>", "Maximum number of audit events to return", "100")
    .option("--since <iso>", "ISO timestamp lower bound for audit events")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { limit?: string; since?: string; json?: boolean }) => {
      const query: Record<string, string> = {};
      if (options.limit) {
        query.limit = options.limit;
      }
      if (options.since) {
        query.since = options.since;
      }
      try {
        const data = await fetchLocksmithAdmin({ cfg, path: "audit", query });
        if (options.json) {
          printJson(data);
          return;
        }
        process.stdout.write(`audit events from ${resolveLocksmithBaseUrl(cfg)}/admin/audit\n`);
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      } catch (error) {
        if (error instanceof LocksmithError) {
          writeError(`audit fetch failed: ${error.code}: ${error.message}`);
        } else {
          writeError(
            `audit fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exitCode = 1;
      }
    });
}
