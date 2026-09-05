import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeSecretInput, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import {
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type UntrustedContentTrustLevel = "untrusted" | "semi-trusted" | "trusted";
export type UntrustedContentOnErrorMode = "pass" | "quarantine";

const DEFAULT_UNTRUSTED_CONTENT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_UNTRUSTED_CONTENT_TIMEOUT_SECONDS = 10;
const DEFAULT_UNTRUSTED_CONTENT_MAX_CONTENT_CHARS = 50_000;
// Fail closed: when the guard service errors, the tool-result path defaults to
// quarantining the result rather than delivering unscanned content. "pass" is
// the explicit operator opt-out for that error path.
export const DEFAULT_UNTRUSTED_CONTENT_ON_ERROR = "quarantine" as const;
const DEFAULT_GUARDED_TOOL_NAMES = ["web_fetch", "browser"] as const;
const DEFAULT_UNTRUSTED_CONTENT_PIPELINE_ID = "default";
const UNTRUSTED_CONTENT_API_KEY_PATH = "plugins.entries.untrusted-content.config.apiKey";

function resolvePluginConfig(cfg?: OpenClawConfig): Record<string, unknown> | undefined {
  const pluginConfig = cfg?.plugins?.entries?.["untrusted-content"]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  return pluginConfig;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeToolNameList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const toolName = normalizeOptionalLowercaseString(entry);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    normalized.push(toolName);
  }
  return normalized.length > 0 ? normalized : [...fallback];
}

function toolNameMatches(entry: string, toolName: string): boolean {
  return entry.endsWith("*") && entry.length > 1
    ? toolName.startsWith(entry.slice(0, -1))
    : toolName === entry;
}

export function resolveUntrustedContentEnabled(cfg?: OpenClawConfig): boolean {
  return resolvePluginConfig(cfg)?.enabled !== false;
}

export function resolveUntrustedContentBaseUrl(cfg?: OpenClawConfig): string {
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    normalizeOptionalString(pluginConfig?.baseUrl) ||
    normalizeOptionalString(process.env.UNTRUSTED_CONTENT_BASE_URL) ||
    DEFAULT_UNTRUSTED_CONTENT_BASE_URL
  );
}

export function resolveUntrustedContentApiKey(cfg?: OpenClawConfig): string | undefined {
  const resolved = resolveSecretInputString({
    value: resolvePluginConfig(cfg)?.apiKey,
    path: UNTRUSTED_CONTENT_API_KEY_PATH,
    defaults: cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return normalizeSecretInput(resolved.value) || undefined;
  }
  if (resolved.status === "missing" || resolved.ref.source !== "env") {
    return undefined;
  }

  const envVarName = resolved.ref.id.trim();
  if (
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg,
      provider: resolved.ref.provider,
      id: envVarName,
    })
  ) {
    return undefined;
  }

  return normalizeSecretInput(process.env[envVarName]) || undefined;
}

export function resolveUntrustedContentPipelineId(cfg?: OpenClawConfig): string {
  return (
    normalizeOptionalString(resolvePluginConfig(cfg)?.pipelineId) ||
    DEFAULT_UNTRUSTED_CONTENT_PIPELINE_ID
  );
}

export function resolveUntrustedContentTlsRejectUnauthorized(cfg?: OpenClawConfig): boolean {
  return resolvePluginConfig(cfg)?.tlsRejectUnauthorized !== false;
}

export function resolveUntrustedContentTimeoutMs(
  cfg?: OpenClawConfig,
  overrideSeconds?: number,
): number {
  const normalizedOverride = normalizePositiveInteger(overrideSeconds);
  if (normalizedOverride) {
    return normalizedOverride * 1000;
  }
  const pluginConfig = resolvePluginConfig(cfg);
  const normalized = normalizePositiveInteger(pluginConfig?.timeoutSeconds);
  return (normalized ?? DEFAULT_UNTRUSTED_CONTENT_TIMEOUT_SECONDS) * 1000;
}

export function resolveUntrustedContentMaxContentChars(cfg?: OpenClawConfig): number {
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    normalizePositiveInteger(pluginConfig?.maxContentChars) ??
    DEFAULT_UNTRUSTED_CONTENT_MAX_CONTENT_CHARS
  );
}

export function resolveUntrustedContentOnErrorMode(
  cfg?: OpenClawConfig,
): UntrustedContentOnErrorMode {
  const configured = resolvePluginConfig(cfg)?.onError;
  // "pass" is the explicit opt-out; anything else (including unset) fails closed.
  return configured === "pass" ? configured : DEFAULT_UNTRUSTED_CONTENT_ON_ERROR;
}

function resolveUntrustedContentGuardedToolNames(cfg?: OpenClawConfig): string[] {
  return normalizeToolNameList(resolvePluginConfig(cfg)?.toolNames, DEFAULT_GUARDED_TOOL_NAMES);
}

function resolveUntrustedContentExcludedToolNames(cfg?: OpenClawConfig): string[] {
  return normalizeToolNameList(resolvePluginConfig(cfg)?.excludedToolNames, []);
}

export function shouldGuardToolResult(cfg: OpenClawConfig | undefined, toolName: string): boolean {
  const normalized = normalizeOptionalLowercaseString(toolName);
  if (!normalized || !resolveUntrustedContentEnabled(cfg)) {
    return false;
  }
  if (
    resolveUntrustedContentExcludedToolNames(cfg).some((entry) =>
      toolNameMatches(entry, normalized),
    )
  ) {
    return false;
  }
  // Entries ending in "*" guard every tool sharing the prefix, so dynamically
  // projected tools (kamiwaza_*, locksmith_kamiwaza_*) stay guarded without
  // config edits when new upstream tools appear.
  return resolveUntrustedContentGuardedToolNames(cfg).some((entry) =>
    toolNameMatches(entry, normalized),
  );
}

export function isUntrustedContentGuardConfigured(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (cfg.plugins?.entries?.["untrusted-content"]?.enabled === false) {
    return false;
  }
  if (cfg.plugins?.entries && Object.hasOwn(cfg.plugins.entries, "untrusted-content")) {
    return true;
  }
  return Boolean(normalizeOptionalString(env?.UNTRUSTED_CONTENT_BASE_URL));
}
