// Ported from old_repo/src/lib/community/antitrust.mjs (lines 10-60)
// Ported from old_repo/src/lib/community/antitrust.mjs (lines 100-181)
// The write-time antitrust guard (spec 05 section 1): a post that declares a commercially sensitive field (current or forward pricing, capacity, wage data) is refused with the reason, whatever its anonymity.
// There is no aggregate path (the benchmark instruments were removed, ADR-042); the rule for one is kept as INV-237's words: at least 5 distinct organisations, none above 25 percent, data older than 3 months.
import { SENSITIVE_FIELDS } from "./labels";

/** The smallest cell the peer-organisation directory publishes, in distinct organisations (the same floor INV-237 names). */
export const K_ANONYMITY_FLOOR = 5;

export type Refusal = { allowed: true; reason: null } | { allowed: false; reason: string };

/** `field` is what the poster declared (null: nothing). A declared sensitive field is always refused; an unknown field name is the caller's 400, not this guard's. */
export function refuseSensitivePost(field: string | null | undefined): Refusal {
  if (!field) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `"${field}" is a commercially sensitive field (current or forward-looking pricing, capacity, or wage data). A single member's disclosure of it is never permitted in a post, whatever the anonymity.`,
  };
}

export const isSensitiveField = (field: string): boolean => SENSITIVE_FIELDS.includes(field);

/** Distinct organisations in a pool (never row count: counting rows is how this control is quietly defeated) against the floor. */
export function kAnonymity(pool: ReadonlyArray<{ organisationKey?: string | null } | string>, minContributors = K_ANONYMITY_FLOOR): { distinctOrganisations: number; minContributors: number; satisfied: boolean } {
  const keys = pool.map((r) => (typeof r === "string" ? r : r.organisationKey)).filter((k): k is string => !!k);
  const distinctOrganisations = new Set(keys).size;
  return { distinctOrganisations, minContributors, satisfied: distinctOrganisations >= minContributors };
}
