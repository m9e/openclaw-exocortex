// Slack helper module implements credential proxy routing behavior.
import type { WebClientOptions } from "@slack/web-api";

export type SlackCredentialProxyConfig = {
  enabled?: boolean;
  botApiUrl?: string;
  appApiUrl?: string;
  userApiUrl?: string;
};

export type SlackCredentialProxyTokenKind = "bot" | "app" | "user";

function normalizeApiUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function resolveSlackCredentialProxyClientOptions(
  config: SlackCredentialProxyConfig | undefined,
  kind: SlackCredentialProxyTokenKind,
): WebClientOptions {
  if (!config || config.enabled === false) {
    return {};
  }
  const apiUrl =
    kind === "bot" ? config.botApiUrl : kind === "app" ? config.appApiUrl : config.userApiUrl;
  const slackApiUrl = normalizeApiUrl(apiUrl);
  return slackApiUrl ? { slackApiUrl, allowAbsoluteUrls: false } : {};
}
