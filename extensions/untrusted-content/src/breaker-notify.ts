/**
 * Out-of-band breaker advisory.
 *
 * When the security breaker trips, the agent run is shut down and the hostile
 * content is withheld. That terminal notice lives in the model transcript, but
 * the operator may not be watching the agent at all. This module pushes a
 * separate, agent-invisible system notification to each connected channel's
 * OWNER destination so a human learns a breaker fired and can release the block.
 *
 * It is best-effort and must never throw: a failed notification can never be
 * allowed to block or unwind the containment path that withheld the content.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Leads every advisory so the operator and any log reader can tell this is a
// push notification, not an agent reply, and is never visible to the model.
export const BREAKER_NOTIFY_PREFIX = "[Notification - Not Visible to Any Agent]";

// Per-channel send timeout so a wedged channel adapter cannot stall the turn
// while the advisory fan-out completes.
const BREAKER_NOTIFY_SEND_TIMEOUT_MS = 8_000;

type BreakerReason = "honeypot" | "confirmed_jailbreak";

type BreakerAdvisoryParams = {
  code: string;
  tool: string;
  breakerReason?: BreakerReason;
  agentName?: string;
  includeCode: boolean;
};

function describeBreakerReason(reason: BreakerReason | undefined): string {
  switch (reason) {
    case "honeypot":
      return "a honeypot tool was triggered";
    case "confirmed_jailbreak":
      return "a confirmed prompt-injection/jailbreak";
    default:
      return "high-risk hostile content";
  }
}

/**
 * Builds the human-facing advisory. Starts with BREAKER_NOTIFY_PREFIX on its own
 * first line. When includeCode is true the unlock code and `clear <CODE>` release
 * instruction are included; this is only safe because the caller targets the
 * per-channel OWNER destination.
 */
export function buildBreakerAdvisory(params: BreakerAdvisoryParams): string {
  const who = params.agentName ? `The agent "${params.agentName}"` : "An agent";
  const reason = describeBreakerReason(params.breakerReason);
  const lines = [
    BREAKER_NOTIFY_PREFIX,
    "A security breaker tripped.",
    `${who} encountered ${reason} while handling the ${params.tool} tool.`,
    "The conversation has been shut down and the hostile content was withheld from the model.",
    params.includeCode
      ? `Release only if you have verified the content is safe — reply:  clear ${params.code}`
      : "An operator code is required to release it (see the operator CLI).",
  ];
  return lines.join("\n");
}

function resolveRiskConfig(cfg?: OpenClawConfig): Record<string, unknown> | undefined {
  const pluginConfig = cfg?.plugins?.entries?.["untrusted-content"]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  const risk = pluginConfig.risk;
  if (!isRecord(risk)) {
    return undefined;
  }
  return risk;
}

/** Default ON: the operator asked for breaker advisories; only an explicit false disables them. */
export function resolveBreakerNotifyEnabled(cfg?: OpenClawConfig): boolean {
  return resolveRiskConfig(cfg)?.breakerNotify !== false;
}

function normalizeChannelAllowList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      normalized.push(entry.trim());
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

// Channel sections that are not actual delivery channels and must never be
// treated as notification targets.
const NON_CHANNEL_KEYS = new Set(["defaults", "modelByChannel"]);

function isChannelEnabled(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return entry.enabled !== false;
}

/**
 * Every configured channel that is enabled. When `risk.breakerNotifyChannels` is
 * a non-empty string array it restricts (intersects) the set. Returns [] when no
 * channels are configured — the common case until channels are wired, where the
 * notifier is a no-op.
 */
export function resolveBreakerNotifyChannels(cfg?: OpenClawConfig): string[] {
  const channels = cfg?.channels;
  if (!channels || typeof channels !== "object") {
    return [];
  }
  const enabled = Object.keys(channels).filter(
    (channelId) => !NON_CHANNEL_KEYS.has(channelId) && isChannelEnabled(channels[channelId]),
  );
  const restrict = normalizeChannelAllowList(resolveRiskConfig(cfg)?.breakerNotifyChannels);
  if (!restrict) {
    return enabled;
  }
  const allowed = new Set(restrict);
  return enabled.filter((channelId) => allowed.has(channelId));
}

/**
 * Owner destination for a channel: an explicit operator target (`defaultTo`)
 * else the first authorized sender (`allowFrom[0]`). Undefined when neither is
 * set. Targeting this destination is what keeps the unlock code off any
 * non-owner/group reader.
 */
export function resolveOwnerTarget(
  cfg: OpenClawConfig | undefined,
  channelId: string,
): string | undefined {
  const entry = cfg?.channels?.[channelId];
  if (!isRecord(entry)) {
    return undefined;
  }
  const target =
    entry.defaultTo ?? (Array.isArray(entry.allowFrom) ? entry.allowFrom[0] : undefined);
  return typeof target === "string" || typeof target === "number" ? String(target) : undefined;
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`breaker-notify send timed out after ${ms}ms`)), ms);
    }),
  ]);
}

type BreakerNotifyParams = {
  code: string;
  tool: string;
  breakerReason?: BreakerReason;
  agentName?: string;
};

/**
 * Pushes the breaker advisory out-of-band to every enabled channel's owner
 * destination. Best-effort and never throws. No-op when disabled or when no
 * channels are configured. The fan-out is awaited (bounded per-channel) so the
 * alert is dispatched before the turn ends, but a single channel failure only
 * logs and never blocks the others.
 */
export async function notifyBreaker(
  api: OpenClawPluginApi,
  params: BreakerNotifyParams,
): Promise<void> {
  if (!resolveBreakerNotifyEnabled(api.config)) {
    return;
  }
  const channels = resolveBreakerNotifyChannels(api.config);
  if (channels.length === 0) {
    return;
  }

  await Promise.allSettled(
    channels.map(async (channelId) => {
      const target = resolveOwnerTarget(api.config, channelId);
      if (!target) {
        return;
      }
      // Targeting the per-channel OWNER destination (defaultTo/allowFrom[0]) is
      // what keeps the unlock code off any non-owner/group reader — adversarial
      // review flagged that the release code must never reach a non-owner. The
      // owner-only target is the whole point, so we include the code here.
      const text = buildBreakerAdvisory({ ...params, includeCode: true });
      const adapter = await api.runtime.channel.outbound
        .loadAdapter(channelId)
        .catch(() => undefined);
      const send = adapter?.sendText;
      if (!send) {
        return;
      }
      await withTimeout(
        send({ cfg: api.config, to: target, text }),
        BREAKER_NOTIFY_SEND_TIMEOUT_MS,
      ).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        api.logger?.warn?.(`breaker-notify: ${channelId} send failed: ${reason}`);
      });
    }),
  );
}
