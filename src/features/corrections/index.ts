export { createCorrection, listCorrections, mapDbError, planCorrection, revokeCorrection } from "./api";
// The correction model (tombstones, removed tags, the suppressed-claim matcher) lives in @/core/corrections; this feature is the admin API and the redaction.
export { loadSuppressedClaims, redactDeep, redactSuppressedClaims, removeClaimText } from "./redact";
export type { RedactionReport, SectionLike, SuppressedClaim } from "./redact";
