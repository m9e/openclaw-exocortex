// Kzproxy plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildKzproxyProvider,
  KZPROXY_DEFAULT_API_KEY_ENV_VAR,
  KZPROXY_DEFAULT_BASE_URL,
  KZPROXY_MODEL_PLACEHOLDER,
  KZPROXY_PROVIDER_LABEL,
} from "./api.js";

const PROVIDER_ID = "kzproxy";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "kzproxy Provider",
  description: "Bundled kzproxy provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "kzproxy",
      docsPath: "/providers/kzproxy",
      envVars: [KZPROXY_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: KZPROXY_PROVIDER_LABEL,
          hint: "Local kzproxy OpenAI-compatible gateway",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: KZPROXY_PROVIDER_LABEL,
              defaultBaseUrl: KZPROXY_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: KZPROXY_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: KZPROXY_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: KZPROXY_PROVIDER_LABEL,
              defaultBaseUrl: KZPROXY_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: KZPROXY_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: KZPROXY_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildKzproxyProvider,
          });
        },
      },
      ...buildProviderReplayFamilyHooks({
        family: "openai-compatible",
        dropReasoningFromHistory: false,
      }),
      wizard: {
        setup: {
          choiceId: "kzproxy",
          choiceLabel: "kzproxy",
          choiceHint: "Local kzproxy OpenAI-compatible gateway",
          groupId: "kzproxy",
          groupLabel: "kzproxy",
          groupHint: "Local model gateway",
          methodId: "custom",
        },
        modelPicker: {
          label: "kzproxy (custom)",
          hint: "Detect models from kzproxy /v1/models",
          methodId: "custom",
        },
      },
    });
  },
});
