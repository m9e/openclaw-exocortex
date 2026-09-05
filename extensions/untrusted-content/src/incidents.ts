/**
 * Persistent store of guard incidents, keyed by a short human code.
 *
 * An incident records a quarantine/summarize/breaker event. For the breaker
 * tier it also acts as an active session lock until explicitly cleared, so the
 * before-agent-run gate can block a session by looking it up by `sessionKey`.
 */
import { randomBytes } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { RiskTier } from "./risk.js";

type IncidentTier = Extract<RiskTier, "summarize" | "quarantine" | "breaker">;

export type Incident = {
  code: string; // short, e.g. "FQ35PZ"
  tier: IncidentTier;
  breakerReason?: "honeypot" | "confirmed_jailbreak";
  sessionKey?: string;
  agentId?: string;
  tool: string;
  score: number;
  contentId?: string; // service content id for raw retrieval (quarantine/breaker)
  sanitizedContent?: string; // sanitized full text retained for summarize-tier reveal
  summary?: string;
  createdAt: number; // epoch ms
  active: boolean; // true only for an enforced (breaker) lock
  clearedAt?: number;
  clearedBy?: string;
};

const INCIDENTS_NAMESPACE = "untrusted-content-incidents";
// Second store mapping a canonical session id -> its active breaker code, so the
// before_agent_run / before_tool_call gates resolve a held session in O(1)
// instead of scanning the whole incidents table on every call. Namespace must be
// a safe path segment (hyphens only, no colons).
const ACTIVE_BLOCKS_NAMESPACE = "untrusted-content-active-blocks";
const INCIDENTS_MAX_ENTRIES = 5000;
const INCIDENTS_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

type ActiveBlockPointer = { code: string };

// Unambiguous uppercase alphabet: no 0/O/1/I/L. Yields [A-HJ-NP-Z2-9].
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_COLLISION_RETRIES = 5;

function openIncidentStore(api: OpenClawPluginApi): PluginStateKeyedStore<Incident> {
  return api.runtime.state.openKeyedStore<Incident>({
    namespace: INCIDENTS_NAMESPACE,
    maxEntries: INCIDENTS_MAX_ENTRIES,
    defaultTtlMs: INCIDENTS_TTL_MS,
  });
}

function openActiveBlockStore(api: OpenClawPluginApi): PluginStateKeyedStore<ActiveBlockPointer> {
  return api.runtime.state.openKeyedStore<ActiveBlockPointer>({
    namespace: ACTIVE_BLOCKS_NAMESPACE,
    maxEntries: INCIDENTS_MAX_ENTRIES,
    defaultTtlMs: INCIDENTS_TTL_MS,
  });
}

/** Generates a 6-char incident code from the unambiguous alphabet. */
export function generateIncidentCode(): string {
  // Rejection sampling keeps the distribution uniform across the alphabet by
  // discarding random bytes that would otherwise bias the modulo.
  const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= max) {
        continue;
      }
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function recordIncident(
  api: OpenClawPluginApi,
  input: Omit<Incident, "code" | "createdAt" | "active"> & { active?: boolean },
): Promise<Incident> {
  const store = openIncidentStore(api);

  let code = generateIncidentCode();
  for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
    const existing = await store.lookup(code);
    if (!existing) {
      break;
    }
    code = generateIncidentCode();
  }

  const incident: Incident = {
    ...input,
    code,
    createdAt: Date.now(),
    active: input.active ?? input.tier === "breaker",
  };
  await store.register(code, incident);
  // Maintain the O(1) session->active-code index so the gates never scan the
  // whole incidents table. `sessionKey` here is the canonical session id the
  // caller resolved via resolveBlockSessionId, so record and lookup match.
  if (incident.active && incident.sessionKey) {
    await openActiveBlockStore(api).register(incident.sessionKey, { code: incident.code });
  }
  return incident;
}

export async function getIncident(
  api: OpenClawPluginApi,
  code: string,
): Promise<Incident | undefined> {
  return openIncidentStore(api).lookup(normalizeCode(code));
}

export async function findActiveBlockForSession(
  api: OpenClawPluginApi,
  sessionKey: string,
): Promise<Incident | undefined> {
  // O(1): resolve the canonical session id to its active code via the index,
  // then load the incident. No full-table scan on this hot gate path.
  const pointer = await openActiveBlockStore(api).lookup(sessionKey);
  if (!pointer) {
    return undefined;
  }
  const incident = await openIncidentStore(api).lookup(pointer.code);
  return incident?.active ? incident : undefined;
}

export async function listActiveIncidents(api: OpenClawPluginApi): Promise<Incident[]> {
  // Active blocks are low-volume, so a full scan is cheap. Sorted newest-first
  // so the operator `blocks` listing leads with the most recent halt.
  const entries = await openIncidentStore(api).entries();
  return entries
    .map((entry) => entry.value)
    .filter((incident) => incident.active)
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

export async function clearIncident(
  api: OpenClawPluginApi,
  code: string,
  clearedBy: string,
): Promise<Incident | undefined> {
  const store = openIncidentStore(api);
  const normalized = normalizeCode(code);
  const existing = await store.lookup(normalized);
  if (!existing) {
    return undefined;
  }
  if (!existing.active) {
    return existing;
  }
  const cleared: Incident = {
    ...existing,
    active: false,
    clearedAt: Date.now(),
    clearedBy,
  };
  await store.register(normalized, cleared);
  // Drop the session->active-code index entry so a future lookup for this
  // session resolves to no active block.
  if (existing.sessionKey) {
    await openActiveBlockStore(api).delete(existing.sessionKey);
  }
  return cleared;
}
