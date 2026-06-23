// Kzproxy plugin module implements models behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { KZPROXY_DEFAULT_BASE_URL, KZPROXY_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildKzproxyProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || KZPROXY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: KZPROXY_PROVIDER_LABEL,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}
