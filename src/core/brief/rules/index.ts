// New in VALID-1: the rule registry and its runner. data/rules.json names every rule (id, refuse or residue, the formats it applies to, the text scope it reads); the rule functions are in ../validate (LOCK-NO-BLOAT-1 folded the rule files there)
// and this module refuses to load when the two disagree. The one rule that needs a hash lives here, so node:crypto stays out of ../validate, which client code imports through the brief index.
import { z } from "zod";

import { tokenHash } from "../../contracts/token-hash";
import { FORMAT_TYPES } from "../contract";
import namesJson from "../data/workspace-names.json";
import rulesJson from "../data/rules.json";
import { proseOf, RULES as PURE_RULES, violation, type BriefModel, type ItemColumns, type Rule, type Violation } from "../validate";

export type { BriefClaim, BriefModel, ItemColumns, Rule, Violation } from "../validate";
export { severityToken } from "../validate";

const NAMES = z.object({ note: z.string(), max_words: z.number().int().min(1), hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1) }).strict().parse(namesJson);
const NAME_HASHES: ReadonlySet<string> = new Set(NAMES.hashes);
/**
 * Where the first workspace or client name is written in `text`, or -1. The names are held only as hashes (data/workspace-names.json, src/core/contracts/token-hash.ts): every run of 1 to max_words
 * consecutive words that opens on a word of 4 letters or more is hashed and looked up, case-insensitively. `hashes` is injectable so a test can plant a name of its own.
 */
export function nameAt(text: string, hashes: ReadonlySet<string> = NAME_HASHES, maxWords: number = NAMES.max_words): number {
  const words = [...text.matchAll(/[a-z]+/gi)];
  for (const [i, w] of words.entries()) {
    if (w[0].length < 4) continue;
    for (let n = 1; n <= maxWords && i + n <= words.length; n++) if (hashes.has(tokenHash(words.slice(i, i + n).map((x) => x[0]).join(" ")))) return w.index;
  }
  return -1;
}
/** The parts of an organization name (split on the slash) whose hash the name list lacks: the report fails when there is one. */
export const namesLacking = (organizationNames: readonly string[], hashes: ReadonlySet<string> = NAME_HASHES): string[] =>
  organizationNames.flatMap((o) => o.split("/").map((n) => n.trim().replace(/\s+/g, " "))).filter((n) => n && !hashes.has(tokenHash(n))).map((n) => tokenHash(n));

const row = z.object({ id: z.string(), severity: z.enum(["refuse", "residue"]), applies_to: z.array(z.enum(FORMAT_TYPES as [string, ...string[]])).min(1), scope: z.enum(["prose", "whole"]) }).strict();
export type RuleRow = z.infer<typeof row>;
export const REGISTRY: readonly RuleRow[] = z.array(row).min(1).parse(rulesJson);

// R2 (V02): the workspace or a named client is written in the brief. The names are held as hashes, never in clear.
const RULES: Readonly<Record<string, Rule>> = {
  ...PURE_RULES,
  "workspace-or-client-named": (b) => {
    const at = nameAt(b.body);
    return at < 0 ? null : violation("workspace-or-client-named", "a workspace or client name is written in the brief", b.body.slice(Math.max(0, at - 20)));
  },
};
/** A rule function with no registry row, or a row with no rule function, fails the import. */
export function assertRegistry(ids: readonly string[], rows: readonly RuleRow[]): void {
  for (const id of ids) if (!rows.some((r) => r.id === id)) throw new Error(`brief rules: ${id} has a rule file and no row in data/rules.json`);
  for (const r of rows) if (!ids.includes(r.id)) throw new Error(`brief rules: data/rules.json names ${r.id} and no rule file holds it`);
}
assertRegistry(Object.keys(RULES), REGISTRY);

/** Run one registered rule: over the prose view or the whole body as its row says (`whole` forces the whole body, the form the register's counts were taken in). */
export function runRule(r: RuleRow, brief: BriefModel, item: ItemColumns, whole = false): Violation | null {
  return (RULES[r.id] as Rule)(r.scope === "prose" && !whole ? { ...brief, body: proseOf(brief) } : brief, item);
}

/**
 * validateBrief(brief, item): every registered rule whose row names the brief's format, run over the brief and the item's columns. `refuse` violations make a claim false or expose internals and block the apply;
 * `residue` violations route the brief to residue with the rule id named. The registry row is the one owner of each rule's severity.
 */
export function validateBrief(brief: BriefModel, item: ItemColumns): { refuse: Violation[]; residue: Violation[] } {
  const out: { refuse: Violation[]; residue: Violation[] } = { refuse: [], residue: [] };
  for (const r of REGISTRY) {
    const v = r.applies_to.includes(brief.format) ? runRule(r, brief, item) : null;
    if (v) out[r.severity].push(v);
  }
  return out;
}
