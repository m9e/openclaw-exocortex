/**
 * Canonical session identity for breaker record + lookup.
 *
 * Tool result middleware and before_tool_call hooks receive a sandbox
 * session key in `ctx.sessionKey`, while before_agent_run receives the plain
 * session key — so an incident recorded under one would never be found under
 * the other with a raw-string match. `sessionId` is present and stable across
 * both PluginHookToolContext and PluginHookAgentContext, so prefer it; fall
 * back to `sessionKey`, then `agentId`. Record and lookup must both run a
 * value through this resolver so they match regardless of sandboxing.
 */
export function resolveBlockSessionId(
  ctx: { sessionId?: string; sessionKey?: string; agentId?: string } | undefined,
): string | undefined {
  for (const candidate of [ctx?.sessionId, ctx?.sessionKey, ctx?.agentId]) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
