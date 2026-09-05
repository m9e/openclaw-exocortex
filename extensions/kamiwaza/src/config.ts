import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_KAMIWAZA_API_URL_CANDIDATES = [
  "https://host.lima.internal/api",
  "http://host.lima.internal:4000/api",
  "http://127.0.0.1:4000/api",
  "https://localhost/api",
  "https://host.docker.internal/api",
  "https://traefik/api",
] as const;
const DEFAULT_KAMIWAZA_TOOL_PREFIX = "kamiwaza";
const DEFAULT_KAMIWAZA_CATALOG_TTL_SECONDS = 30;
const DEFAULT_KAMIWAZA_TIMEOUT_SECONDS = 30;
const DEFAULT_KAMIWAZA_CREDENTIAL_STORE_PATH = "~/.openclaw/credentials/kamiwaza-pat-store.json";
const DEFAULT_KAMIWAZA_DELEGATION_HEADER = "x-kamiwaza-agent-delegation";
const DEFAULT_KAMIWAZA_DELEGATION_ISSUER = "openclaw";
const DEFAULT_KAMIWAZA_DELEGATION_AUDIENCE = "kamiwaza-tools";
const DEFAULT_KAMIWAZA_DELEGATION_TTL_SECONDS = 60;

type KamiwazaDelegationConfig = {
  enabled?: boolean;
  required?: boolean;
  signingSecret?: unknown;
  header?: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
};

type KamiwazaPluginConfig = {
  apiUrl?: string;
  apiUrlCandidates?: string[];
  apiToken?: unknown;
  credentialStorePath?: string;
  credentialHost?: string;
  toolPrefix?: string;
  includeTypes?: string[];
  extensionNames?: string[];
  genericTool?: boolean;
  promptCatalog?: boolean;
  verifyTls?: boolean;
  catalogTtlSeconds?: number;
  timeoutSeconds?: number;
  discoveryConcurrency?: number;
  delegation?: KamiwazaDelegationConfig;
};

type KamiwazaPatCredential = {
  host_name?: unknown;
  aliases?: unknown;
  issuer?: unknown;
  token?: unknown;
};

type KamiwazaPatStore = {
  source?: unknown;
  source_host?: unknown;
  credentials?: unknown;
  active_tokens?: unknown;
};

type CredentialStoreCacheEntry = {
  path: string;
  credentials: KamiwazaPatCredential[];
};

let credentialStoreCache: CredentialStoreCacheEntry | undefined;

function pluginConfig(cfg?: OpenClawConfig): KamiwazaPluginConfig | undefined {
  const value = cfg?.plugins?.entries?.kamiwaza?.config;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: Plugin config is manifest-validated; resolvers normalize optional values before use.
  return value as KamiwazaPluginConfig;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeConfiguredSecret(value: unknown, configPath: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path: configPath,
    }),
  );
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveKamiwazaApiUrlCandidates(cfg?: OpenClawConfig): string[] {
  const config = pluginConfig(cfg);
  const configured = normalizeOptionalString(config?.apiUrl);
  if (configured) {
    return [configured];
  }
  for (const envName of [
    "KAMIWAZA_API_URL",
    "KAMIWAZA_API_URI",
    "KAMIWAZA_BASE_URL",
    "KAMIWAZA_BASE_URI",
  ]) {
    const value = normalizeSecretInput(process.env[envName]);
    if (value) {
      return [value];
    }
  }
  const candidates = normalizeStringArray(config?.apiUrlCandidates);
  return candidates.length > 0 ? candidates : [...DEFAULT_KAMIWAZA_API_URL_CANDIDATES];
}

export function resolveKamiwazaToolPrefix(cfg?: OpenClawConfig): string {
  return normalizeOptionalString(pluginConfig(cfg)?.toolPrefix) ?? DEFAULT_KAMIWAZA_TOOL_PREFIX;
}

export function resolveKamiwazaIncludeTypes(cfg?: OpenClawConfig): string[] {
  const configured = normalizeStringArray(pluginConfig(cfg)?.includeTypes);
  return configured.length > 0 ? configured : ["tool"];
}

/**
 * Glob patterns (`*` matches any run of characters) restricting which Kamiwaza
 * extension names are discovered. A shared cluster hosts every runtime's
 * extensions, so without this each runtime would discover and project all of
 * them; setting e.g. `["*-agentzero"]` scopes a runtime to its own tools.
 */
export function resolveKamiwazaExtensionNamePatterns(cfg?: OpenClawConfig): string[] {
  return normalizeStringArray(pluginConfig(cfg)?.extensionNames);
}

export function kamiwazaExtensionNameMatches(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }
  const lower = name.toLowerCase();
  return patterns.some((pattern) => {
    const regex = new RegExp(
      `^${pattern
        .toLowerCase()
        .split("*")
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return regex.test(lower);
  });
}

/** Bounded fan-out for per-extension MCP discovery; defaults to 8. */
export function resolveKamiwazaDiscoveryConcurrency(cfg?: OpenClawConfig): number {
  const configured = pluginConfig(cfg)?.discoveryConcurrency;
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) {
    return Math.floor(configured);
  }
  return 8;
}

export function resolveKamiwazaGenericToolEnabled(cfg?: OpenClawConfig): boolean {
  return pluginConfig(cfg)?.genericTool !== false;
}

export function resolveKamiwazaPromptCatalogEnabled(cfg?: OpenClawConfig): boolean {
  return pluginConfig(cfg)?.promptCatalog !== false;
}

export function resolveKamiwazaVerifyTls(cfg?: OpenClawConfig): boolean {
  return pluginConfig(cfg)?.verifyTls !== false;
}

export function resolveKamiwazaCatalogTtlMs(cfg?: OpenClawConfig): number {
  return (
    (normalizePositiveInteger(pluginConfig(cfg)?.catalogTtlSeconds) ??
      DEFAULT_KAMIWAZA_CATALOG_TTL_SECONDS) * 1000
  );
}

export function resolveKamiwazaTimeoutMs(cfg?: OpenClawConfig, overrideSeconds?: number): number {
  return (
    (normalizePositiveInteger(overrideSeconds) ??
      normalizePositiveInteger(pluginConfig(cfg)?.timeoutSeconds) ??
      DEFAULT_KAMIWAZA_TIMEOUT_SECONDS) * 1000
  );
}

export function resolveKamiwazaCredentialStorePath(cfg?: OpenClawConfig): string {
  return expandHomePath(
    normalizeOptionalString(pluginConfig(cfg)?.credentialStorePath) ||
      normalizeSecretInput(process.env.KAMIWAZA_PAT_STORE_PATH) ||
      DEFAULT_KAMIWAZA_CREDENTIAL_STORE_PATH,
  );
}

function readCredentialStore(filePath: string): KamiwazaPatCredential[] {
  if (credentialStoreCache?.path === filePath) {
    return credentialStoreCache.credentials;
  }
  let credentials: KamiwazaPatCredential[];
  try {
    // SAFETY: Store fields stay unknown and are checked before use; malformed JSON is caught.
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as KamiwazaPatStore;
    const rawCredentials = Array.isArray(parsed.credentials)
      ? parsed.credentials
      : Array.isArray(parsed.active_tokens)
        ? parsed.active_tokens
        : [];
    credentials = rawCredentials.filter(
      (entry): entry is KamiwazaPatCredential =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
  } catch {
    credentials = [];
  }
  credentialStoreCache = { path: filePath, credentials };
  return credentials;
}

function hostFromUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizedHostAliases(value: string | undefined): string[] {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const aliases = new Set([trimmed]);
  if (trimmed.endsWith(".local")) {
    aliases.add(trimmed.slice(0, -".local".length));
  }
  return [...aliases];
}

function credentialHosts(credential: KamiwazaPatCredential): string[] {
  const hosts = new Set<string>();
  if (typeof credential.host_name === "string" && credential.host_name.trim()) {
    for (const host of normalizedHostAliases(credential.host_name)) {
      hosts.add(host);
    }
  }
  if (Array.isArray(credential.aliases)) {
    for (const alias of credential.aliases) {
      if (typeof alias === "string" && alias.trim()) {
        for (const host of normalizedHostAliases(alias)) {
          hosts.add(host);
        }
      }
    }
  }
  if (typeof credential.issuer === "string" && credential.issuer.trim()) {
    for (const host of normalizedHostAliases(hostFromUrl(credential.issuer))) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

function sourceHostFromCredentialStore(filePath: string): string | undefined {
  try {
    // SAFETY: Store fields stay unknown and are checked before use; malformed JSON is caught.
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as KamiwazaPatStore;
    const source = parsed.source;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      // SAFETY: The preceding object check permits lookup; source_host remains unknown.
      const sourceHost = (source as { source_host?: unknown }).source_host;
      if (typeof sourceHost === "string") {
        return sourceHost;
      }
    }
    return typeof parsed.source_host === "string" ? parsed.source_host : undefined;
  } catch {
    return undefined;
  }
}

function tokenFromCredentialStore(cfg?: OpenClawConfig): string | undefined {
  const filePath = resolveKamiwazaCredentialStorePath(cfg);
  const credentials = readCredentialStore(filePath);
  if (credentials.length === 0) {
    return undefined;
  }
  const configuredHost = normalizeOptionalString(pluginConfig(cfg)?.credentialHost);
  const apiHosts = resolveKamiwazaApiUrlCandidates(cfg)
    .map(hostFromUrl)
    .filter((host): host is string => Boolean(host));
  const sourceHost = sourceHostFromCredentialStore(filePath);
  const desiredHostGroups = [
    normalizedHostAliases(configuredHost),
    [...apiHosts, sourceHost].flatMap((host) => normalizedHostAliases(host)),
  ].filter((hosts) => hosts.length > 0);
  for (const desiredHostGroup of desiredHostGroups) {
    const desiredHosts = new Set(desiredHostGroup);
    for (const credential of credentials) {
      if (credentialHosts(credential).some((host) => desiredHosts.has(host))) {
        return normalizeSecretInput(typeof credential?.token === "string" ? credential.token : "");
      }
    }
  }
  if (credentials.length === 1) {
    const [credential] = credentials;
    return normalizeSecretInput(typeof credential?.token === "string" ? credential.token : "");
  }
  return undefined;
}

export function resolveKamiwazaApiToken(cfg?: OpenClawConfig): string | undefined {
  return (
    normalizeConfiguredSecret(
      pluginConfig(cfg)?.apiToken,
      "plugins.entries.kamiwaza.config.apiToken",
    ) ||
    normalizeSecretInput(process.env.KAMIWAZA_API_KEY) ||
    tokenFromCredentialStore(cfg)
  );
}

export type KamiwazaDelegationRuntimeConfig = {
  enabled: boolean;
  required: boolean;
  signingSecret?: string;
  header: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
};

export function resolveKamiwazaDelegationConfig(
  cfg?: OpenClawConfig,
): KamiwazaDelegationRuntimeConfig {
  const delegation = pluginConfig(cfg)?.delegation;
  const signingSecret =
    normalizeConfiguredSecret(
      delegation?.signingSecret,
      "plugins.entries.kamiwaza.config.delegation.signingSecret",
    ) || normalizeSecretInput(process.env.KAMIWAZA_DELEGATION_SIGNING_SECRET);
  return {
    enabled: delegation?.enabled === true || Boolean(signingSecret),
    required: delegation?.required === true,
    signingSecret,
    header: normalizeOptionalString(delegation?.header) ?? DEFAULT_KAMIWAZA_DELEGATION_HEADER,
    issuer: normalizeOptionalString(delegation?.issuer) ?? DEFAULT_KAMIWAZA_DELEGATION_ISSUER,
    audience: normalizeOptionalString(delegation?.audience) ?? DEFAULT_KAMIWAZA_DELEGATION_AUDIENCE,
    ttlSeconds:
      normalizePositiveInteger(delegation?.ttlSeconds) ?? DEFAULT_KAMIWAZA_DELEGATION_TTL_SECONDS,
  };
}

export function resetKamiwazaCredentialStoreCacheForTest(): void {
  credentialStoreCache = undefined;
}
