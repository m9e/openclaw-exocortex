import crypto from "node:crypto";
import type { AssociativeRecallCandidate } from "@openclaw/memory-core/api.js";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { toSingleLineErrorMessage } from "./recall-state.js";
import type { ResolvedActiveRecallPluginConfig } from "./types.js";

type AssociativeRecallPromptSnippet = AssociativeRecallCandidate;
type AssociativeRecallSampler = (
  params: Parameters<
    (typeof import("@openclaw/memory-core/api.js"))["sampleAssociativeRecallCandidates"]
  >[0],
) => ReturnType<
  (typeof import("@openclaw/memory-core/api.js"))["sampleAssociativeRecallCandidates"]
>;

let associativeRecallSamplerForTests: AssociativeRecallSampler | undefined;

function hashUnitInterval(seed: string): number {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 13);
  const value = Number.parseInt(hex, 16);
  return Number.isFinite(value) ? value / 0x10000000000000 : 0;
}

function hashShortText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function buildAssociativeRecallSeed(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  latestUserMessage: string;
  recentTurnCount: number;
  nowMs?: number;
}): string {
  const day = new Date(params.nowMs ?? Date.now()).toISOString().slice(0, 10);
  return [
    "associative-recall",
    params.agentId,
    params.sessionKey ?? params.sessionId ?? "no-session",
    params.messageProvider ?? "no-provider",
    params.channelId ?? "no-channel",
    day,
    String(params.recentTurnCount),
    hashShortText(params.latestUserMessage),
  ].join(":");
}

function shouldAttemptAssociativeRecall(
  config: ResolvedActiveRecallPluginConfig["associativeRecall"],
  seed: string,
): boolean {
  if (!config.enabled || config.intrusionRate <= 0) {
    return false;
  }
  if (config.intrusionRate >= 1) {
    return true;
  }
  return hashUnitInterval(`${seed}:roll`) < config.intrusionRate;
}

function normalizeAssociativeDuplicateText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isAssociativeRecallDuplicate(
  candidate: AssociativeRecallCandidate,
  activeSummary: string | null,
): boolean {
  if (!activeSummary) {
    return false;
  }
  const summary = normalizeAssociativeDuplicateText(activeSummary);
  const snippet = normalizeAssociativeDuplicateText(candidate.snippet);
  return snippet.length >= 24 && summary.includes(snippet.slice(0, Math.min(snippet.length, 120)));
}

async function persistAssociativeRecallEvent(params: {
  api: OpenClawPluginApi;
  workspaceDir: string;
  seed: string;
  selected: readonly AssociativeRecallCandidate[];
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  try {
    await appendMemoryHostEvent(params.workspaceDir, {
      type: "memory.associative_recall.injected",
      timestamp: new Date().toISOString(),
      seed: params.seed,
      selectedCount: params.selected.length,
      candidates: params.selected.map((candidate) => ({
        key: candidate.key,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        signalCount: candidate.signalCount,
        ...(candidate.source ? { source: candidate.source } : {}),
        ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
      })),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    });
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: associative recall event logging failed: ${toSingleLineErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

async function loadAssociativeRecallSampler(): Promise<AssociativeRecallSampler> {
  if (associativeRecallSamplerForTests) {
    return associativeRecallSamplerForTests;
  }
  const { sampleAssociativeRecallCandidates } = await import("@openclaw/memory-core/api.js");
  return sampleAssociativeRecallCandidates;
}

export async function maybeResolveAssociativeRecall(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  latestUserMessage: string;
  recentTurnCount: number;
  activeSummary: string | null;
  workspaceDir: string;
  assertActive: () => void;
}): Promise<AssociativeRecallPromptSnippet[]> {
  const associativeConfig = params.config.associativeRecall;
  const seed = buildAssociativeRecallSeed({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    messageProvider: params.messageProvider,
    channelId: params.channelId,
    latestUserMessage: params.latestUserMessage,
    recentTurnCount: params.recentTurnCount,
  });
  if (!shouldAttemptAssociativeRecall(associativeConfig, seed)) {
    return [];
  }

  const workspaceDir = params.workspaceDir;
  params.assertActive();
  try {
    const sampleAssociativeRecallCandidates = await loadAssociativeRecallSampler();
    const sampled = await sampleAssociativeRecallCandidates({
      workspaceDir,
      seed,
      limit: Math.max(associativeConfig.maxSnippets * 4, associativeConfig.maxSnippets),
      minSignalCount: associativeConfig.minSignalCount,
      minScore: associativeConfig.minScore,
      maxAgeDays: associativeConfig.maxAgeDays,
      includePromoted: associativeConfig.includePromoted,
      includeStructural: associativeConfig.includeStructural,
      recencyHalfLifeDays: associativeConfig.recencyHalfLifeDays,
      maxSnippetChars: associativeConfig.maxSnippetChars,
    });
    params.assertActive();
    const selected = sampled.selected
      .filter((candidate) => !isAssociativeRecallDuplicate(candidate, params.activeSummary))
      .slice(0, associativeConfig.maxSnippets);
    if (selected.length === 0) {
      return [];
    }
    void persistAssociativeRecallEvent({
      api: params.api,
      workspaceDir,
      seed,
      selected,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    if (params.config.logging) {
      params.api.logger.info?.(
        `active-memory: associative recall injected count=${String(selected.length)} eligible=${String(
          sampled.eligibleCount,
        )}`,
      );
    }
    return selected;
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: associative recall unavailable: ${toSingleLineErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return [];
  }
}

export function setAssociativeRecallSamplerForTests(
  value: AssociativeRecallSampler | undefined,
): void {
  associativeRecallSamplerForTests = value;
}
