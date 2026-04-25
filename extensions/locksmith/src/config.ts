import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export const DEFAULT_LOCKSMITH_BASE_URL = "http://127.0.0.1:9200";
export const DEFAULT_LOCKSMITH_TIMEOUT_SECONDS = 30;
export const DEFAULT_LOCKSMITH_CATALOG_TTL_SECONDS = 30;
export const DEFAULT_LOCKSMITH_MAX_RESPONSE_BYTES = 262_144;

export type LocksmithToolConfig = {
  enabled?: boolean;
  label?: string;
  description?: string;
};

export type LocksmithProjectedTool = {
  slug: string;
  toolName: string;
  label?: string;
  description?: string;
};

type LocksmithPluginConfig = {
  baseUrl?: string;
  inboundToken?: unknown;
  catalogTtlSeconds?: number;
  timeoutSeconds?: number;
  maxResponseBytes?: number;
  promptCatalog?: boolean;
  tools?: Record<string, LocksmithToolConfig>;
};

const TOOL_NAME_PREFIX = "locksmith_";
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

function normalizeSlug(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !SLUG_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function projectedToolName(slug: string): string {
  return `${TOOL_NAME_PREFIX}${slug}`;
}

function resolvePluginConfig(cfg?: OpenClawConfig): LocksmithPluginConfig | undefined {
  const pluginConfig = cfg?.plugins?.entries?.locksmith?.config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return undefined;
  }
  return pluginConfig as LocksmithPluginConfig;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

export function resolveLocksmithBaseUrl(cfg?: OpenClawConfig): string {
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    normalizeOptionalString(pluginConfig?.baseUrl) ||
    normalizeSecretInput(process.env.LOCKSMITH_BASE_URL) ||
    DEFAULT_LOCKSMITH_BASE_URL
  );
}

export function resolveLocksmithInboundToken(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    normalizeConfiguredSecret(
      pluginConfig?.inboundToken,
      "plugins.entries.locksmith.config.inboundToken",
    ) ||
    normalizeSecretInput(process.env.LOCKSMITH_INBOUND_TOKEN) ||
    undefined
  );
}

export function resolveLocksmithTimeoutMs(cfg?: OpenClawConfig, overrideSeconds?: number): number {
  const normalizedOverride = normalizePositiveInteger(overrideSeconds);
  if (normalizedOverride) {
    return normalizedOverride * 1000;
  }
  const pluginConfig = resolvePluginConfig(cfg);
  const normalized = normalizePositiveInteger(pluginConfig?.timeoutSeconds);
  return (normalized ?? DEFAULT_LOCKSMITH_TIMEOUT_SECONDS) * 1000;
}

export function resolveLocksmithCatalogTtlMs(cfg?: OpenClawConfig): number {
  const pluginConfig = resolvePluginConfig(cfg);
  const normalized = normalizePositiveInteger(pluginConfig?.catalogTtlSeconds);
  return (normalized ?? DEFAULT_LOCKSMITH_CATALOG_TTL_SECONDS) * 1000;
}

export function resolveLocksmithMaxResponseBytes(
  cfg?: OpenClawConfig,
  overrideBytes?: number,
): number {
  const normalizedOverride = normalizePositiveInteger(overrideBytes);
  if (normalizedOverride) {
    return normalizedOverride;
  }
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    normalizePositiveInteger(pluginConfig?.maxResponseBytes) ?? DEFAULT_LOCKSMITH_MAX_RESPONSE_BYTES
  );
}

export function resolveLocksmithPromptCatalogEnabled(cfg?: OpenClawConfig): boolean {
  const pluginConfig = resolvePluginConfig(cfg);
  return pluginConfig?.promptCatalog !== false;
}

/**
 * Resolve operator-declared projected tools, sorted deterministically by slug.
 *
 * Returns the canonical list used both for prompt-cache-stable `registerTool({ names })`
 * and for synthetic factory output. Disabled, malformed, or duplicate slugs are dropped.
 * The lowercase-sorted order makes registration insensitive to object insertion order.
 */
export function resolveLocksmithProjectedTools(cfg?: OpenClawConfig): LocksmithProjectedTool[] {
  const pluginConfig = resolvePluginConfig(cfg);
  const raw = pluginConfig?.tools;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const projected: LocksmithProjectedTool[] = [];
  for (const [rawSlug, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value;
    if (entry.enabled !== true) {
      continue;
    }
    const slug = normalizeSlug(rawSlug);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const label = normalizeOptionalString(entry.label);
    const description = normalizeOptionalString(entry.description);
    projected.push({
      slug,
      toolName: projectedToolName(slug),
      label,
      description,
    });
  }
  projected.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return projected;
}
