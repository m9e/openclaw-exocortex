// Slack plugin module implements client behavior.
import { createHash } from "node:crypto";
import { type WebClientOptions, WebClient } from "@slack/web-api";
import { resolveSlackWebClientOptions, resolveSlackWriteClientOptions } from "./client-options.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const slackWriteClientCache = new Map<string, WebClient>();
const slackTokenClientOptions = new Map<string, WebClientOptions>();

export {
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  resolveSlackSocketModeWebSocketAgent,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(
    token,
    resolveSlackWebClientOptions(mergeSlackClientOptions(token, options)),
  );
}

export function createSlackWriteClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(
    token,
    resolveSlackWriteClientOptions(mergeSlackClientOptions(token, options)),
  );
}

export function createSlackTokenCacheKey(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}

export function getSlackWriteClient(token: string, options: WebClientOptions = {}): WebClient {
  const resolvedOptions = resolveSlackWriteClientOptions(mergeSlackClientOptions(token, options));
  const tokenKey = createSlackTokenCacheKey(
    `${token}\n${resolvedOptions.slackApiUrl ?? ""}\n${resolvedOptions.allowAbsoluteUrls ?? ""}`,
  );
  const cached = slackWriteClientCache.get(tokenKey);
  if (cached) {
    slackWriteClientCache.delete(tokenKey);
    slackWriteClientCache.set(tokenKey, cached);
    return cached;
  }
  const client = new WebClient(token, resolvedOptions);
  if (slackWriteClientCache.size >= SLACK_WRITE_CLIENT_CACHE_MAX) {
    const oldestTokenKey = slackWriteClientCache.keys().next().value;
    if (oldestTokenKey) {
      slackWriteClientCache.delete(oldestTokenKey);
    }
  }
  slackWriteClientCache.set(tokenKey, client);
  return client;
}

export function clearSlackWriteClientCacheForTest(): void {
  slackWriteClientCache.clear();
  slackTokenClientOptions.clear();
}

export function registerSlackTokenClientOptions(
  token: string | undefined,
  options: WebClientOptions,
) {
  const normalized = token?.trim();
  if (!normalized) {
    return;
  }
  const tokenKey = createSlackTokenCacheKey(normalized);
  if (options.slackApiUrl) {
    slackTokenClientOptions.set(tokenKey, options);
  } else {
    slackTokenClientOptions.delete(tokenKey);
  }
}

function mergeSlackClientOptions(token: string, options: WebClientOptions): WebClientOptions {
  const registered = slackTokenClientOptions.get(createSlackTokenCacheKey(token));
  if (!registered) {
    return options;
  }
  const headers =
    registered.headers || options.headers
      ? {
          ...registered.headers,
          ...options.headers,
        }
      : undefined;
  return {
    ...registered,
    ...options,
    ...(headers ? { headers } : {}),
  };
}
