import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { registerLocksmithCli } from "./src/cli.js";
import { buildLocksmithPromptGuidance } from "./src/prompt-guidance.js";
import { createLocksmithCallTool } from "./src/tool.js";

export default definePluginEntry({
  id: "locksmith",
  name: "Locksmith",
  description: "Optional tool bridge for Agent Locksmith credential-proxy deployments.",
  register(api) {
    api.registerTool(createLocksmithCallTool(api) as AnyAgentTool, { optional: true });
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
    api.on("before_prompt_build", async () => ({
      prependSystemContext: await buildLocksmithPromptGuidance(api.config),
    }));
  },
});
