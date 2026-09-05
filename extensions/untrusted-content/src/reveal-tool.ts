import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { getIncident } from "./incidents.js";

const UntrustedContentRevealToolSchema = Type.Object(
  {
    code: Type.String({
      description: "Incident code from a summarized untrusted-content notice (e.g. FQ35PZ).",
    }),
  },
  { additionalProperties: false },
);

/**
 * Agent-facing reveal tool. Only elevated-but-not-hostile (summarize-tier)
 * incidents that retained sanitized full text can be revealed back to the
 * agent. Quarantine/breaker incidents and anything without sanitized content
 * are refused; this tool NEVER reaches raw quarantine content (no
 * fetchQuarantineRaw call), so hostile payloads stay operator-only.
 */
export function createUntrustedContentRevealTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "untrusted_content_reveal",
    label: "Untrusted Content Reveal",
    description:
      "Reveal the sanitized full text of an elevated-risk (summarize-tier) untrusted-content incident by its code. Quarantine/breaker incidents require operator review and cannot be revealed.",
    parameters: UntrustedContentRevealToolSchema,
    execute: async (_toolCallId: string, params: unknown) => {
      const rawParams = asNonArrayRecord(params);
      const code = readStringParam(rawParams, "code", { required: true });
      const inc = await getIncident(api, code);
      const normalized = code.trim().toUpperCase();
      if (inc && inc.tier === "summarize" && inc.sanitizedContent) {
        return jsonResult({
          code: inc.code,
          tier: inc.tier,
          content: wrapExternalContent(inc.sanitizedContent, {
            source: "unknown",
            includeWarning: true,
          }),
        });
      }
      return jsonResult({
        code: normalized,
        revealed: false,
        message: `Code ${normalized} is not revealable: only elevated-but-not-hostile (summarize-tier) content can be revealed to the agent. Quarantine/breaker content requires operator review.`,
      });
    },
  };
}
