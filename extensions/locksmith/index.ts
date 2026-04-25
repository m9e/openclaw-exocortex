import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { registerLocksmithCli } from "./src/cli.js";
import { resolveLocksmithProjectedTools } from "./src/config.js";
import {
  buildLocksmithDynamicCatalogGuidance,
  buildLocksmithStaticPromptGuidance,
} from "./src/prompt-guidance.js";
import { createLocksmithCallTool, createLocksmithProjectedToolFactory } from "./src/tool.js";

export default definePluginEntry({
  id: "locksmith",
  name: "Locksmith",
  description: "Optional tool bridge for Agent Locksmith credential-proxy deployments.",
  register(api) {
    api.registerTool(createLocksmithCallTool(api) as AnyAgentTool, { optional: true });

    // Project one synthetic tool per operator-declared, enabled slug. Names
    // are predeclared at registration time so the agent prompt prefix is
    // byte-stable regardless of Locksmith service availability or restarts.
    // See plan §2 (synthetic factory) and §5 (prompt-cache stability).
    const projected = resolveLocksmithProjectedTools(api.config);
    if (projected.length > 0) {
      api.registerTool(createLocksmithProjectedToolFactory(api), {
        names: projected.map((entry) => entry.toolName),
        optional: true,
      });
    }

    api.registerCli(
      ({ program }) => {
        registerLocksmithCli(program, api.config);
      },
      {
        descriptors: [
          {
            name: "locksmith",
            description: "Inspect the configured Agent Locksmith service",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.on("before_prompt_build", async () => {
      // Static guidance lives above the prompt-cache boundary; dynamic
      // catalog text lives below so service state changes don't invalidate
      // cached prefix bytes. See plan §2 (prompt-guidance) and §5.
      const prependSystemContext = buildLocksmithStaticPromptGuidance(api.config);
      const appendSystemContext = await buildLocksmithDynamicCatalogGuidance(api.config);
      return appendSystemContext === undefined
        ? { prependSystemContext }
        : { prependSystemContext, appendSystemContext };
    });
  },
});
