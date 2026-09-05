import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rankShortTermPromotionCandidates } from "./short-term-promotion-ranking.js";
import { filterLiveShortTermRecallEntries } from "./short-term-promotion-record.js";
import { resolveStorePath } from "./short-term-promotion-store.js";
import {
  buildClaimHash,
  clampScore,
  isContaminatedDreamingSnippet,
  normalizeMemoryPath,
  normalizeSnippet,
  SHORT_TERM_RECALL_MAX_ENTRIES,
  toFiniteNonNegativeInt,
  toFiniteScore,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHORT_TERM_RECALL_MAX_SNIPPET_CHARS = 800;
const GRAPH_STRUCTURAL_RECALL_RELATIVE_PATH = path.join(
  "memory",
  "graph",
  "structural-recall.jsonl",
);

export type AssociativeRecallCandidate = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  source?: "short-term" | "graph" | "pykeen";
  provenance?: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  signalCount: number;
  score: number;
  maxScore: number;
  lastRecalledAt: string;
};

export type SampleAssociativeRecallCandidatesResult = {
  storePath: string;
  eligibleCount: number;
  selected: AssociativeRecallCandidate[];
};

function hashUnitInterval(seed: string): number {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 13);
  const value = Number.parseInt(hex, 16);
  return Number.isFinite(value) ? value / 0x10000000000000 : 0;
}

function deterministicWeightedPriority(seed: string, key: string, weight: number): number {
  const boundedWeight = Math.max(0.000001, weight);
  const u = Math.max(Number.EPSILON, hashUnitInterval(`${seed}:${key}`));
  return Math.log(u) / boundedWeight;
}

function truncateAssociativeRecallSnippet(snippet: string, maxChars: number): string {
  const normalized = normalizeSnippet(snippet);
  const limit = Math.max(40, Math.min(SHORT_TERM_RECALL_MAX_SNIPPET_CHARS, Math.floor(maxChars)));
  if (normalized.length <= limit) {
    return normalized;
  }
  const bounded = normalized.slice(0, limit).trimEnd();
  const lastBoundary = bounded.search(/\s\S*$/);
  return (lastBoundary > 0 ? bounded.slice(0, lastBoundary) : bounded).trimEnd();
}

function resolveWorkspaceRelativePath(workspaceDir: string, rawPath: string): string | null {
  const normalized = normalizeMemoryPath(rawPath).trim();
  if (!normalized || normalized.includes("\0")) {
    return null;
  }
  if (path.isAbsolute(rawPath)) {
    const relative = path.relative(workspaceDir, rawPath).replaceAll("\\", "/");
    if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
      return null;
    }
    return normalizeMemoryPath(relative);
  }
  const resolved = path.resolve(workspaceDir, normalized);
  const relative = path.relative(workspaceDir, resolved).replaceAll("\\", "/");
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function normalizeGraphStructuralRecallSource(value: unknown): "graph" | "pykeen" {
  return value === "pykeen" ? "pykeen" : "graph";
}

function normalizeGraphStructuralRecallTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeGraphStructuralRecallLine(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.floor(num);
}

async function readJsonlRecords(filePath: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: unknown[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return records;
}

async function loadGraphStructuralRecallCandidates(params: {
  workspaceDir: string;
  seed: string;
  minScore?: number;
  maxAgeDays?: number;
  maxSnippetChars?: number;
  nowMs?: number;
}): Promise<AssociativeRecallCandidate[]> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return [];
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const artifactPath = path.join(workspaceDir, GRAPH_STRUCTURAL_RECALL_RELATIVE_PATH);
  const records = await readJsonlRecords(artifactPath);
  const minScore = toFiniteScore(params.minScore, 0);
  const maxAgeDays = toFiniteNonNegativeInt(params.maxAgeDays, -1);
  const candidates: AssociativeRecallCandidate[] = [];
  const seen = new Set<string>();

  for (const raw of records) {
    const record = asRecord(raw);
    if (!record) {
      continue;
    }
    const rawPath = typeof record.path === "string" ? record.path : "";
    const relativePath = resolveWorkspaceRelativePath(workspaceDir, rawPath);
    if (!relativePath) {
      continue;
    }
    const sourcePath = path.resolve(workspaceDir, relativePath);
    try {
      await fs.access(sourcePath);
    } catch {
      continue;
    }
    const rawSnippet = typeof record.snippet === "string" ? record.snippet : "";
    const snippet = truncateAssociativeRecallSnippet(
      rawSnippet,
      params.maxSnippetChars ?? SHORT_TERM_RECALL_MAX_SNIPPET_CHARS,
    );
    if (!snippet || isContaminatedDreamingSnippet(snippet)) {
      continue;
    }
    const score = toFiniteScore(record.score, 0);
    if (score < minScore) {
      continue;
    }
    const lastSeenAt = normalizeGraphStructuralRecallTimestamp(
      record.lastSeenAt ?? record.updatedAt ?? record.timestamp,
      nowIso,
    );
    const lastSeenAtMs = Date.parse(lastSeenAt);
    const ageDays = Number.isFinite(lastSeenAtMs)
      ? Math.max(0, (nowMs - lastSeenAtMs) / DAY_MS)
      : 0;
    if (maxAgeDays >= 0 && ageDays > maxAgeDays) {
      continue;
    }
    const startLine = normalizeGraphStructuralRecallLine(record.startLine, 1);
    const endLine = Math.max(
      startLine,
      normalizeGraphStructuralRecallLine(record.endLine, startLine),
    );
    const source = normalizeGraphStructuralRecallSource(record.source);
    const baseKey =
      typeof record.key === "string" && record.key.trim()
        ? record.key.trim()
        : `${source}:${relativePath}:${startLine}:${endLine}:${buildClaimHash(snippet)}`;
    const key = `${source}:${baseKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const signalCount = Math.max(1, toFiniteNonNegativeInt(record.signalCount, 1));
    const provenanceEntries = [
      typeof record.entity === "string" && record.entity.trim()
        ? `entity=${record.entity.trim()}`
        : "",
      typeof record.relation === "string" && record.relation.trim()
        ? `relation=${record.relation.trim()}`
        : "",
      typeof record.polarity === "string" && record.polarity.trim()
        ? `polarity=${record.polarity.trim()}`
        : "",
      typeof record.extraction === "string" && record.extraction.trim()
        ? `extraction=${record.extraction.trim()}`
        : "",
      typeof record.neighbor === "string" && record.neighbor.trim()
        ? `neighbor=${record.neighbor.trim()}`
        : "",
    ].filter(Boolean);
    candidates.push({
      key,
      path: relativePath,
      startLine,
      endLine,
      snippet,
      source,
      provenance: provenanceEntries.join(" ").slice(0, 240),
      recallCount: 0,
      dailyCount: 0,
      groundedCount: signalCount,
      signalCount,
      score: clampScore(score),
      maxScore: clampScore(toFiniteScore(record.maxScore, score)),
      lastRecalledAt: lastSeenAt,
    });
  }

  return candidates.toSorted((a, b) => {
    const aPriority = deterministicWeightedPriority(params.seed, a.key, Math.max(0.001, a.score));
    const bPriority = deterministicWeightedPriority(params.seed, b.key, Math.max(0.001, b.score));
    if (bPriority !== aPriority) {
      return bPriority - aPriority;
    }
    return a.key.localeCompare(b.key);
  });
}

export async function sampleAssociativeRecallCandidates(params: {
  workspaceDir: string;
  seed: string;
  limit?: number;
  minSignalCount?: number;
  minScore?: number;
  maxAgeDays?: number;
  includePromoted?: boolean;
  includeStructural?: boolean;
  recencyHalfLifeDays?: number;
  maxSnippetChars?: number;
  nowMs?: number;
}): Promise<SampleAssociativeRecallCandidatesResult> {
  const workspaceDir = params.workspaceDir.trim();
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(0, Math.floor(params.limit))
      : 1;
  if (!workspaceDir || limit <= 0) {
    return {
      storePath: workspaceDir ? resolveStorePath(workspaceDir) : "",
      eligibleCount: 0,
      selected: [],
    };
  }

  const seed = params.seed.trim() || "associative-recall";
  const candidates = await rankShortTermPromotionCandidates({
    workspaceDir,
    limit: SHORT_TERM_RECALL_MAX_ENTRIES,
    minScore: params.minScore ?? 0,
    minRecallCount: params.minSignalCount ?? 1,
    minUniqueQueries: 0,
    maxAgeDays: params.maxAgeDays,
    includePromoted: params.includePromoted,
    recencyHalfLifeDays: params.recencyHalfLifeDays,
    nowMs: params.nowMs,
  });
  const liveEntries = await filterLiveShortTermRecallEntries({
    workspaceDir,
    entries: candidates.map((candidate) => ({
      key: candidate.key,
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      source: candidate.source,
      snippet: candidate.snippet,
      recallCount: candidate.recallCount,
      dailyCount: candidate.dailyCount ?? 0,
      groundedCount: candidate.groundedCount ?? 0,
      totalScore: candidate.avgScore * Math.max(1, candidate.signalCount ?? candidate.recallCount),
      maxScore: candidate.maxScore,
      firstRecalledAt: candidate.firstRecalledAt,
      lastRecalledAt: candidate.lastRecalledAt,
      queryHashes: [],
      recallDays: candidate.recallDays,
      conceptTags: candidate.conceptTags,
      ...(candidate.claimHash ? { claimHash: candidate.claimHash } : {}),
      ...(candidate.promotedAt ? { promotedAt: candidate.promotedAt } : {}),
    })),
  });
  const liveKeys = new Set(liveEntries.map((entry) => entry.key));
  const shortTermEligible = candidates
    .filter((candidate) => liveKeys.has(candidate.key))
    .map((candidate): AssociativeRecallCandidate => ({
      key: candidate.key,
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: truncateAssociativeRecallSnippet(
        candidate.snippet,
        params.maxSnippetChars ?? SHORT_TERM_RECALL_MAX_SNIPPET_CHARS,
      ),
      source: "short-term",
      recallCount: candidate.recallCount,
      dailyCount: Math.max(0, Math.floor(candidate.dailyCount ?? 0)),
      groundedCount: Math.max(0, Math.floor(candidate.groundedCount ?? 0)),
      signalCount: Math.max(
        0,
        Math.floor(
          candidate.signalCount ??
            candidate.recallCount +
              Math.max(0, Math.floor(candidate.dailyCount ?? 0)) +
              Math.max(0, Math.floor(candidate.groundedCount ?? 0)),
        ),
      ),
      score: clampScore(candidate.score),
      maxScore: clampScore(candidate.maxScore),
      lastRecalledAt: candidate.lastRecalledAt,
    }));
  const structuralCandidates =
    params.includeStructural === false
      ? []
      : await loadGraphStructuralRecallCandidates({
          workspaceDir,
          seed,
          minScore: params.minScore ?? 0,
          maxAgeDays: params.maxAgeDays,
          maxSnippetChars: params.maxSnippetChars,
          nowMs: params.nowMs,
        });
  const eligible = [...shortTermEligible, ...structuralCandidates]
    .map((candidate) => ({
      candidate,
      priority: deterministicWeightedPriority(
        seed,
        candidate.key,
        Math.max(0.001, candidate.score),
      ),
    }))
    .toSorted((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.candidate.key.localeCompare(right.candidate.key);
    });

  const selected = eligible.slice(0, limit).map(({ candidate }) => candidate);

  return {
    storePath: resolveStorePath(workspaceDir),
    eligibleCount: eligible.length,
    selected,
  };
}
