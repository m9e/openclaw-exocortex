import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

export type UntrustedContentTrustLevel = "untrusted" | "semi-trusted" | "trusted";
export type UntrustedContentOnErrorMode = "pass" | "quarantine";

type UntrustedContentPluginConfig = {
  enabled?: boolean;
  baseUrl?: string;
  toolNames?: unknown;
  trustLevel?: UntrustedContentTrustLevel;
  timeoutSeconds?: number;
  maxContentChars?: number;
  onError?: UntrustedContentOnErrorMode;
  sanitize?: boolean;
  guardrail?: boolean;
  scan?: boolean;
  windowSize?: number;
  windowOverlap?: number;
};

export const DEFAULT_UNTRUSTED_CONTENT_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_UNTRUSTED_CONTENT_TIMEOUT_SECONDS = 10;
export const DEFAULT_UNTRUSTED_CONTENT_MAX_CONTENT_CHARS = 50_000;
export const DEFAULT_UNTRUSTED_CONTENT_ON_ERROR = "pass" as const;
export const DEFAULT_GUARDED_TOOL_NAMES = ["web_fetch", "browser"] as const;

function resolvePluginConfig(cfg?: OpenClawConfig): UntrustedContentPluginConfig | undefined {
  const pluginConfig = cfg?.plugins?.entries?.["untrusted-content"]?.config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return undefined;
  }
  return pluginConfig as UntrustedContentPluginConfig;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_GUARDED_TOOL_NAMES];
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
  return normalized.length > 0 ? normalized : [...DEFAULT_GUARDED_TOOL_NAMES];
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

export function resolveUntrustedContentTrustLevel(
  cfg?: OpenClawConfig,
): UntrustedContentTrustLevel {
  const configured = resolvePluginConfig(cfg)?.trustLevel;
  return configured === "semi-trusted" || configured === "trusted" ? configured : "untrusted";
}

export function resolveUntrustedContentOnErrorMode(
  cfg?: OpenClawConfig,
): UntrustedContentOnErrorMode {
  const configured = resolvePluginConfig(cfg)?.onError;
  return configured === "quarantine" ? configured : DEFAULT_UNTRUSTED_CONTENT_ON_ERROR;
}

export function resolveUntrustedContentGuardedToolNames(cfg?: OpenClawConfig): string[] {
  return normalizeToolNameList(resolvePluginConfig(cfg)?.toolNames);
}

export function shouldGuardToolResult(cfg: OpenClawConfig | undefined, toolName: string): boolean {
  const normalized = normalizeOptionalLowercaseString(toolName);
  if (!normalized || !resolveUntrustedContentEnabled(cfg)) {
    return false;
  }
  return resolveUntrustedContentGuardedToolNames(cfg).includes(normalized);
}

export function resolveUntrustedContentPipelineOverrides(cfg?: OpenClawConfig): {
  trustLevel: UntrustedContentTrustLevel;
  sanitize?: boolean;
  guardrail?: boolean;
  scan?: boolean;
  windowSize?: number;
  windowOverlap?: number;
} {
  const pluginConfig = resolvePluginConfig(cfg);
  return {
    trustLevel: resolveUntrustedContentTrustLevel(cfg),
    ...(typeof pluginConfig?.sanitize === "boolean" ? { sanitize: pluginConfig.sanitize } : {}),
    ...(typeof pluginConfig?.guardrail === "boolean" ? { guardrail: pluginConfig.guardrail } : {}),
    ...(typeof pluginConfig?.scan === "boolean" ? { scan: pluginConfig.scan } : {}),
    ...(normalizePositiveInteger(pluginConfig?.windowSize)
      ? { windowSize: normalizePositiveInteger(pluginConfig?.windowSize) }
      : {}),
    ...(pluginConfig?.windowOverlap !== undefined &&
    typeof pluginConfig.windowOverlap === "number" &&
    Number.isFinite(pluginConfig.windowOverlap) &&
    pluginConfig.windowOverlap >= 0
      ? { windowOverlap: Math.floor(pluginConfig.windowOverlap) }
      : {}),
  };
}

export function isUntrustedContentGuardConfigured(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (cfg.plugins?.entries?.["untrusted-content"]?.enabled === false) {
    return false;
  }
  if (
    cfg.plugins?.entries &&
    Object.prototype.hasOwnProperty.call(cfg.plugins.entries, "untrusted-content")
  ) {
    return true;
  }
  return Boolean(normalizeOptionalString(env?.UNTRUSTED_CONTENT_BASE_URL));
}
