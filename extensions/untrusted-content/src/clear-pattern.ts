/**
 * Matches a bare conversational `clear <CODE>` message, where CODE is a 6-char
 * incident code from the unambiguous alphabet ([A-HJ-NP-Z2-9]). Shared by the
 * before_dispatch handler and its test so the accepted shape has one owner.
 */
export const CONVERSATIONAL_CLEAR_RE = /^\s*clear\s+([A-HJ-NP-Z2-9]{6})\s*$/i;
