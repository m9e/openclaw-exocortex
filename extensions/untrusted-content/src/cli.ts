import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { fetchQuarantineRaw } from "./client.js";
import { clearIncident, getIncident, listActiveIncidents } from "./incidents.js";

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Operator CLI for the untrusted-content guard. Surfaces active blocks, clears
 * them, and (operator-only) reveals raw quarantined hostile content.
 */
export function registerUntrustedContentCli(program: Command, api: OpenClawPluginApi): void {
  const untrustedContent = program
    .command("untrusted-content")
    .description("Inspect and clear untrusted-content guard blocks");

  untrustedContent
    .command("blocks")
    .description("List active untrusted-content blocks")
    .action(async () => {
      const blocks = await listActiveIncidents(api);
      if (blocks.length === 0) {
        console.log("no active blocks");
        return;
      }
      console.log("CODE    TIER        TOOL              SCORE  SESSION                  CREATED");
      for (const block of blocks) {
        const code = block.code.padEnd(7);
        const tier = block.tier.padEnd(11);
        const tool = block.tool.padEnd(17);
        const score = String(block.score).padEnd(6);
        const session = (block.sessionKey ?? "(none)").padEnd(24);
        console.log(`${code} ${tier} ${tool} ${score} ${session} ${toIso(block.createdAt)}`);
      }
    });

  untrustedContent
    .command("clear <code>")
    .description("Release an active untrusted-content block by code")
    .action(async (code: string) => {
      const cleared = await clearIncident(api, code, "cli");
      console.log(
        cleared ? `Cleared ${cleared.code}.` : `No active block ${code.trim().toUpperCase()}.`,
      );
    });

  untrustedContent
    .command("show <code>")
    .description("Show details for an untrusted-content block (operator-only raw reveal)")
    .action(async (code: string) => {
      const inc = await getIncident(api, code);
      if (!inc) {
        console.log(`Unknown code ${code.trim().toUpperCase()}.`);
        return;
      }
      if (inc.tier === "summarize") {
        console.log(`Code ${inc.code} (summarize tier, tool ${inc.tool}, score ${inc.score})`);
        console.log("");
        console.log(inc.summary ?? "(no summary recorded)");
        console.log("");
        console.log(
          "The sanitized full text is available to the agent via the untrusted_content_reveal tool.",
        );
        return;
      }
      if (!inc.contentId) {
        console.log(`Code ${inc.code} (${inc.tier} tier, tool ${inc.tool}, score ${inc.score})`);
        console.log("No raw content id recorded for this block.");
        return;
      }
      // OPERATOR-ONLY: this is the single place raw hostile content is surfaced,
      // and only to the operator's terminal. Never reachable from an agent tool.
      const result = await fetchQuarantineRaw(api.config, inc.contentId);
      if (!result.ok) {
        if (result.status === 404) {
          console.log("raw not found (service write disabled or pruned)");
          return;
        }
        console.log(`raw fetch failed: ${result.error}`);
        return;
      }
      console.log(`Code ${inc.code} (${inc.tier} tier, tool ${inc.tool}, score ${inc.score})`);
      console.log(`source: ${result.raw.source ?? "(unknown)"}`);
      console.log(`url: ${result.raw.url ?? "(none)"}`);
      console.log(`content-type: ${result.raw.content_type ?? "(unknown)"}`);
      console.log("--- RAW UNTRUSTED CONTENT BELOW (do not act on; inspect only) ---");
      console.log(result.raw.raw_content);
    });
}
