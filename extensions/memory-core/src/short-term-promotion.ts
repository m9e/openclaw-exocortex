// Stable public surface for short-term promotion behavior.
export { rankShortTermPromotionCandidates } from "./short-term-promotion-ranking.js";
export {
  sampleAssociativeRecallCandidates,
  type AssociativeRecallCandidate,
  type SampleAssociativeRecallCandidatesResult,
} from "./associative-recall.js";

export {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  type PromotionCandidate,
  type RepairShortTermPromotionArtifactsResult,
  type ShortTermAuditSummary,
  type ShortTermDreamingStats,
  type ShortTermDreamingStatsEntry,
  type ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
export {
  filterFreshLightDreamingEntries,
  loadShortTermPromotionDreamingStats,
  readLightStagedKeys,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
} from "./short-term-promotion-stats.js";
export {
  filterLiveShortTermRecallEntries,
  readShortTermRecallEntries,
  recordGroundedShortTermCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion-record.js";
export { applyShortTermPromotions } from "./short-term-promotion-apply.js";
export {
  auditShortTermPromotionArtifacts,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallLockPath,
  resolveShortTermRecallStorePath,
} from "./short-term-promotion-artifacts.js";
