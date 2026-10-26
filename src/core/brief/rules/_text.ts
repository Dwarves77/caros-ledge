// New in VALID-1: the shared text helpers of the rules: the compiled pattern lists (data), the prose view of a brief, and the one-line pattern rule.
import { z } from "zod";

import { tokenHash } from "../../contracts/token-hash";
import patternsJson from "../data/rule-patterns.json";
import namesJson from "../data/workspace-names.json";

import type { BriefModel, Rule, Violation } from "./types";

const re = z.object({ re: z.string(), flags: z.string().optional() });
const DATA = z.object({
  patterns: z.record(z.string(), z.object({ register: z.string(), patterns: z.array(re).min(1) })),
  limits: z.record(z.string(), z.object({ register: z.string(), min: z.number().optional(), max: z.number().optional(), window: z.number().optional() })),
}).strict().parse(patternsJson);
const NAMES = z.object({ note: z.string(), max_words: z.number().int().min(1), hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1) }).strict().parse(namesJson);
const NAME_HASHES: ReadonlySet<string> = new Set(NAMES.hashes);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
const COMPILED: Record<string, RegExp[]> = {
  ...Object.fromEntries(Object.entries(DATA.patterns).map(([k, v]) => [k, v.patterns.map((p) => new RegExp(p.re, p.flags))])),
};
export function patternsOf(key: string): RegExp[] {
  const r = COMPILED[key];
  if (!r) throw new Error(`rule-patterns: no pattern list named ${key}`);
  return r;
}
export const limitOf = (key: string): { min?: number | undefined; max?: number | undefined; window?: number | undefined } => DATA.limits[key] ?? {};

export const violation = (rule: string, detail: string, text: string): Violation => ({ rule, detail, excerpt: text.replace(/\s+/g, " ").trim().slice(0, 80) });

const PROSE = new WeakMap<BriefModel, string>();
/** What a removed verbatim run leaves behind: one visible, non-space mark, so a table cell or a sentence that held a quote is not left empty (an empty cell is a defect the structural rule must not invent). */
const VERBATIM_MARK = "\uFFFC";
/** The body with verbatim text removed: every «...» run, the source_span of every FACT claim, and the runs an adapter marked exempt (claim_text is the author's own wording and is not exempt). A source's own wording and punctuation are never edited. */
export function proseOf(b: BriefModel): string {
  let t = PROSE.get(b);
  if (t === undefined) {
    t = b.body.replace(/«[^»]*»/g, VERBATIM_MARK);
    const runs = [...b.exempt, ...b.claims.filter((c) => c.kind === "FACT").map((c) => c.span)];
    for (const r of runs) if (r?.trim()) t = t.replace(new RegExp(escapeRe(r.trim()), "gi"), VERBATIM_MARK);
    PROSE.set(b, t);
  }
  return t;
}

/** A rule that is one pattern list over the body it is given (the runner hands it the prose view or the whole body, as the registry says). */
export function textRule(id: string, key: string): Rule {
  const res = patternsOf(key);
  return (brief) => {
    for (const r of res) {
      const m = r.exec(brief.body);
      if (m) return violation(id, `${key}: ${JSON.stringify(m[0].slice(0, 40))}`, brief.body.slice(m.index));
    }
    return null;
  };
}
