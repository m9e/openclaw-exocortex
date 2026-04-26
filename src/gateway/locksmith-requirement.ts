import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { isLoopbackHost } from "./net.js";

const LOCKSMITH_PLUGIN_ID = "locksmith";
const DEFAULT_LOCKSMITH_BASE_URL = "http://127.0.0.1:9200";
const DEFAULT_LOCKSMITH_STARTUP_TIMEOUT_MS = 5000;

type LocksmithToolConfig = {
  enabled?: boolean;
};

type LocksmithPluginConfig = {
  baseUrl?: string;
  inboundToken?: unknown;
  required?: boolean;
  genericTool?: boolean;
  tools?: Record<string, LocksmithToolConfig>;
};

export type RequiredLocksmithStartupConfig = {
  baseUrl: string;
  inboundToken: string;
  projectedTools: string[];
  timeoutMs: number;
};

export type RequiredLocksmithStartupStatus = {
  baseUrl: string;
  activeTools: string[];
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class RequiredLocksmithError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RequiredLocksmithError";
  }
}

function resolveLocksmithEntry(cfg?: OpenClawConfig): { enabled?: boolean; config?: unknown } {
  const entry = cfg?.plugins?.entries?.[LOCKSMITH_PLUGIN_ID];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
}

function resolveLocksmithPluginConfig(cfg?: OpenClawConfig): LocksmithPluginConfig | undefined {
  const pluginConfig = resolveLocksmithEntry(cfg).config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return undefined;
  }
  return pluginConfig as LocksmithPluginConfig;
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/u, "");
}

function parseRequiredBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new RequiredLocksmithError(`Locksmith required mode has an invalid baseUrl: ${raw}`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RequiredLocksmithError("Locksmith required mode only supports http(s) baseUrl.");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new RequiredLocksmithError(
      "Locksmith required mode requires a loopback baseUrl unless the gateway startup guard is extended for remote attestations.",
    );
  }
  return normalizeBaseUrl(parsed.toString());
}

function resolveProjectedToolSlugs(pluginConfig?: LocksmithPluginConfig): string[] {
  const raw = pluginConfig?.tools;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const projected: string[] = [];
  for (const [slug, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if (value.enabled === true) {
      projected.push(slug.toLowerCase());
    }
  }
  return projected.toSorted();
}

export function resolveRequiredLocksmithStartupConfig(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): RequiredLocksmithStartupConfig | null {
  const pluginConfig = resolveLocksmithPluginConfig(cfg);
  const required =
    pluginConfig?.required === true || isTruthyEnvValue(env.OPENCLAW_REQUIRE_LOCKSMITH);
  if (!required) {
    return null;
  }

  if (cfg?.plugins?.enabled === false) {
    throw new RequiredLocksmithError("Locksmith is required, but plugins.enabled is false.");
  }
  if (cfg?.plugins?.deny?.includes(LOCKSMITH_PLUGIN_ID)) {
    throw new RequiredLocksmithError("Locksmith is required, but plugins.deny includes locksmith.");
  }
  const entry = resolveLocksmithEntry(cfg);
  if (entry.enabled !== true) {
    throw new RequiredLocksmithError(
      "Locksmith is required, but the locksmith plugin is not enabled.",
    );
  }
  if (pluginConfig?.genericTool !== false) {
    throw new RequiredLocksmithError(
      "Locksmith is required, but plugins.entries.locksmith.config.genericTool is not false. Use projected tools for a fixed allowlist.",
    );
  }

  const projectedTools = resolveProjectedToolSlugs(pluginConfig);
  if (projectedTools.length === 0) {
    throw new RequiredLocksmithError(
      "Locksmith is required, but no projected Locksmith tools are configured.",
    );
  }

  const inboundToken =
    normalizeConfiguredSecret(
      pluginConfig?.inboundToken,
      "plugins.entries.locksmith.config.inboundToken",
    ) ||
    normalizeSecretInput(env.LOCKSMITH_INBOUND_TOKEN) ||
    undefined;
  if (!inboundToken) {
    throw new RequiredLocksmithError(
      "Locksmith is required, but no inboundToken or LOCKSMITH_INBOUND_TOKEN is configured.",
    );
  }

  const baseUrl =
    normalizeOptionalString(pluginConfig?.baseUrl) ||
    normalizeSecretInput(env.LOCKSMITH_BASE_URL) ||
    DEFAULT_LOCKSMITH_BASE_URL;

  return {
    baseUrl: parseRequiredBaseUrl(baseUrl),
    inboundToken,
    projectedTools,
    timeoutMs: DEFAULT_LOCKSMITH_STARTUP_TIMEOUT_MS,
  };
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/u, ""), `${normalizeBaseUrl(baseUrl)}/`).toString();
}

async function fetchWithTimeout(params: {
  fetchImpl: FetchLike;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    return await params.fetchImpl(params.url, {
      ...params.init,
      signal: params.init?.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRequiredJson(params: {
  fetchImpl: FetchLike;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  label: string;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchWithTimeout(params);
  } catch (error) {
    throw new RequiredLocksmithError(
      `Locksmith required startup check failed: ${params.label} unreachable.`,
      {
        cause: error,
      },
    );
  }
  if (!response.ok) {
    throw new RequiredLocksmithError(
      `Locksmith required startup check failed: ${params.label} returned ${response.status} ${response.statusText}.`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new RequiredLocksmithError(
      `Locksmith required startup check failed: ${params.label} returned invalid JSON.`,
      { cause: error },
    );
  }
}

function extractActiveToolNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const tools = (payload as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) =>
      tool && typeof tool === "object" && !Array.isArray(tool)
        ? (tool as { name?: unknown }).name
        : undefined,
    )
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim().toLowerCase())
    .toSorted();
}

export async function assertRequiredLocksmithReady(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): Promise<RequiredLocksmithStartupStatus | null> {
  const requirement = resolveRequiredLocksmithStartupConfig(params.cfg, params.env ?? process.env);
  if (!requirement) {
    return null;
  }

  const fetchImpl = params.fetchImpl ?? globalThis.fetch.bind(globalThis);
  await fetchRequiredJson({
    fetchImpl,
    url: buildUrl(requirement.baseUrl, "/health"),
    timeoutMs: requirement.timeoutMs,
    label: "/health",
  });

  const unauthenticatedTools = await fetchWithTimeout({
    fetchImpl,
    url: buildUrl(requirement.baseUrl, "/tools"),
    timeoutMs: requirement.timeoutMs,
  });
  if (unauthenticatedTools.ok) {
    throw new RequiredLocksmithError(
      "Locksmith required startup check failed: unauthenticated /tools succeeded, so inbound bearer auth is not enforced.",
    );
  }
  if (unauthenticatedTools.status !== 401 && unauthenticatedTools.status !== 403) {
    throw new RequiredLocksmithError(
      `Locksmith required startup check failed: unauthenticated /tools returned ${unauthenticatedTools.status} ${unauthenticatedTools.statusText}, expected 401 or 403.`,
    );
  }

  const toolsPayload = await fetchRequiredJson({
    fetchImpl,
    url: buildUrl(requirement.baseUrl, "/tools"),
    init: {
      headers: {
        Authorization: `Bearer ${requirement.inboundToken}`,
      },
    },
    timeoutMs: requirement.timeoutMs,
    label: "authenticated /tools",
  });
  const activeTools = extractActiveToolNames(toolsPayload);
  if (activeTools.length === 0) {
    throw new RequiredLocksmithError(
      "Locksmith required startup check failed: authenticated /tools returned no active tools.",
    );
  }
  const activeSet = new Set(activeTools);
  const missing = requirement.projectedTools.filter((slug) => !activeSet.has(slug));
  if (missing.length > 0) {
    throw new RequiredLocksmithError(
      `Locksmith required startup check failed: projected tool(s) not active on Locksmith: ${missing.join(", ")}.`,
    );
  }

  return {
    baseUrl: requirement.baseUrl,
    activeTools,
  };
}
