// Ported from old_repo/src/lib/community/antitrust.mjs (lines 10-60)
// Ported from old_repo/src/lib/community/antitrust.mjs (lines 100-181)
// The write-time antitrust guard (spec 05 section 1): a post, reply or edit whose TEXT states a commercially sensitive figure (a rate, wage, capacity or pricing figure) is refused with the reason, whatever its anonymity.
// The guard reads the words, never a declaration: a guard that depends on the author declaring their own violation refuses nothing, and the rooms composer never had the field. The rules are data (data/antitrust-rules.json): a rule
// fires when every one of its patterns matches the text; the field it names is one of the vocabulary's sensitive fields. There is no aggregate path (the benchmark instruments were removed, ADR-042); the rule for one is kept as
// INV-237's words: at least 5 distinct organisations, none above 25 percent, data older than 3 months.
import { z } from "zod";

import rulesJson from "./data/antitrust-rules.json";
import { SENSITIVE_FIELD_LABELS } from "./labels";

/** The smallest cell the peer-organisation directory publishes, in distinct organisations (the same floor INV-237 names). */
export const K_ANONYMITY_FLOOR = 5;

export type Refusal = { allowed: true; reason: null } | { allowed: false; reason: string; field: string };

const file = z.object({ vars: z.record(z.string(), z.string()), rules: z.array(z.object({ field: z.string(), all: z.array(z.string()).min(1) })).min(1) }).parse(rulesJson);
const expand = (pattern: string): string => pattern.replace(/\{(\w+)\}/g, (_m, name: string) => file.vars[name] ?? "");
const RULES = file.rules.map((r) => {
  if (!(r.field in SENSITIVE_FIELD_LABELS)) throw new Error(`antitrust-rules.json: ${r.field} is not a sensitive field of the vocabulary`);
  return { field: r.field, tests: r.all.map((p) => new RegExp(expand(p), "i")) };
});

/** Refuse text that states a sensitive figure. Every text a composer sends (title, body, reply, edit) goes through here on the server. */
export function refuseSensitiveText(...texts: ReadonlyArray<string | null | undefined>): Refusal {
  const text = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
  const hit = RULES.find((r) => r.tests.every((t) => t.test(text)));
  if (!hit) return { allowed: true, reason: null };
  return {
    allowed: false,
    field: hit.field,
    reason: `This looks like it states a ${SENSITIVE_FIELD_LABELS[hit.field]?.toLowerCase() ?? hit.field} figure. A single member's rate, wage, capacity or pricing figure is never permitted in a post, whatever the anonymity. Take the figure out, or cite where it is published instead of repeating it.`,
  };
}

/** Distinct organisations in a pool (never row count: counting rows is how this control is quietly defeated) against the floor. */
export function kAnonymity(pool: ReadonlyArray<{ organisationKey?: string | null } | string>, minContributors = K_ANONYMITY_FLOOR): { distinctOrganisations: number; minContributors: number; satisfied: boolean } {
  const keys = pool.map((r) => (typeof r === "string" ? r : r.organisationKey)).filter((k): k is string => !!k);
  const distinctOrganisations = new Set(keys).size;
  return { distinctOrganisations, minContributors, satisfied: distinctOrganisations >= minContributors };
}
