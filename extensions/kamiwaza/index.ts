import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { registerKamiwazaCli } from "./src/cli.js";
import { resolveKamiwazaGenericToolEnabled } from "./src/config.js";
import {
  buildKamiwazaDynamicCatalogGuidance,
  buildKamiwazaStaticPromptGuidance,
} from "./src/prompt-guidance.js";
import { createKamiwazaCallTool } from "./src/tool.js";

export default definePluginEntry({
  id: "kamiwaza",
  name: "Kamiwaza",
  description: "Direct Kamiwaza MCP tool bridge for local platform deployments.",
  register(api) {
    if (resolveKamiwazaGenericToolEnabled(api.config)) {
      // SAFETY: The factory supplies the SDK tool name, schema, and JSON-result execute contract.
      api.registerTool((ctx) => createKamiwazaCallTool(api, ctx) as AnyAgentTool, {
        name: "kamiwaza_call",
        optional: true,
      });
    }

    api.registerCli(
      ({ program }) => {
        registerKamiwazaCli(program, api.config);
      },
      {
        descriptors: [
          {
            name: "kamiwaza",
            description: "Inspect and call direct Kamiwaza MCP tools",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.on("before_prompt_build", async () => {
      const prependSystemContext = buildKamiwazaStaticPromptGuidance();
      const appendSystemContext = await buildKamiwazaDynamicCatalogGuidance(api.config);
      return appendSystemContext === undefined
        ? { prependSystemContext }
        : { prependSystemContext, appendSystemContext };
    });
  },
});
