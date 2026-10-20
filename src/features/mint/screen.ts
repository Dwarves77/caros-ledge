// Ported from old_repo/scripts/mint/screen-rules.mjs (lines 1-62)
// Ported from old_repo/scripts/mint/screen-rules.mjs (lines 823-909)
// Ported from old_repo/scripts/mint/lib/screen-verdict.mjs (lines 1-24)
// Ported from old_repo/scripts/mint/screen-reconcile-records.mjs (lines 20-77)
// The relevance screen (ADR-020): a CELEX-root heuristic, then the ON rules, then the OFF rules (first match wins; ON before OFF is load-bearing, a CBAM corrigendum
// must not fall into a language-correction denylist), then the preparatory-act and no-signal ambiguity. The rules are DATA (data/screen-rules.json, each with an
// explicit verdict and its ruling citation), validated and compiled once. A reviewed verdict (the screen_verdicts table) overrides only a rule's `ambiguous`.
// An ambiguous verdict never waits for a human (ruling 1): the caller holds the row with the quarantine dwell as its maximum age.
import { z } from "zod";

import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { decodeUriOrNull } from "@/core/shared/url";

import rulesData from "./data/screen-rules.json";
import type { Screen, ScreenVerdictName } from "./types";

const re = z.object({ pattern: z.string().min(1), flags: z.string() });
const RulesFile = z.object({
  celex_roots: z.array(z.object({ sector: z.string(), year: z.number(), type: z.string(), number: z.number(), rule: z.string(), label: z.string(), rationale: z.string(), ruling: z.string() })).length(4),
  rules: z.array(re.extend({
    name: z.string(), group: z.enum(["on", "off"]), verdict: z.enum(["on_vertical", "off_vertical"]), exclude: re.optional(), label: z.string(), rationale: z.string(),
    rationale_kind: z.enum(["mechanism", "mechanism_question", "fails_mechanism"]), open_question: z.string().optional(), ruling: z.string().min(1),
  })),
});
interface Compiled { name: string; verdict: ScreenVerdictName; test: RegExp; exclude: RegExp | null; label: string; note: string }

let compiled: { roots: z.infer<typeof RulesFile>["celex_roots"]; rules: Compiled[] } | null = null;
/** Validate and compile the rule table once. Throws when the table breaks its own contract (an OFF rule before an ON rule, a duplicate name). */
function loadRules() {
  if (compiled) return compiled;
  const f = RulesFile.parse(rulesData);
  const names = new Set<string>();
  let seenOff = false;
  const rules = f.rules.map((r) => {
    if (names.has(r.name)) throw new Error(`screen rules: duplicate rule name ${r.name}`);
    names.add(r.name);
    if (r.group === "off") seenOff = true;
    else if (seenOff) throw new Error(`screen rules: ON rule ${r.name} follows an OFF rule (ON before OFF is load-bearing)`);
    const kind = r.rationale_kind === "mechanism" ? " Mechanism: " : r.rationale_kind === "mechanism_question" ? " Mechanism question: " : " Fails mechanism: ";
    return { name: r.name, verdict: r.verdict, test: new RegExp(r.pattern, r.flags), exclude: r.exclude ? new RegExp(r.exclude.pattern, r.exclude.flags) : null, label: r.label, note: `${kind}${r.rationale}` };
  });
  return (compiled = { roots: f.celex_roots, rules });
}

const CELEX_RE = /CELEX:?\s*(\d)(\d{4})([A-Z]{1,2})(\d+)/i;
function parseCelex(text: string | null | undefined) {
  if (!text) return null;
  const decoded = decodeUriOrNull(text) ?? text;
  const m = CELEX_RE.exec(decoded);
  return m ? { raw: m[0], sector: m[1] ?? "", year: parseInt(m[2] ?? "0", 10), type: (m[3] ?? "").toUpperCase(), number: parseInt(m[4] ?? "0", 10) } : null;
}

/** The text every rule matches: the title, else a pseudo-title read from the document URL (a descriptive slug or filename). */
function deriveSearchText(title: string | null | undefined, documentUrl: string | null | undefined): string {
  const t = String(title ?? "").trim();
  if (t) return t;
  const u = String(documentUrl ?? "");
  const filename = /[?&]filename=([^&]+)/i.exec(u)?.[1];
  let seg = filename ?? (u.split(/[?#]/)[0] ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
  seg = decodeUriOrNull(seg) ?? seg;
  return seg.replace(/\.(pdf|html?|aspx?|docx?)$/i, "").replace(/[_-]+/g, " ").replace(/\b(en|fr|de)\b$/i, "").trim();
}

export interface RuleVerdict { verdict: ScreenVerdictName; rule: string; basis: string }
/** Classify one census row for freight-sustainability relevance. surface_tags are carried for traceability only, never a decision input (ADR-020 Amendment 1). */
function classifyRelevance(row: { title?: string | null; document_url?: string | null; surface_tags?: readonly string[] | null } = {}): RuleVerdict {
  const { roots, rules } = loadRules();
  const t = String(row.title ?? "").trim();
  const u = String(row.document_url ?? "").trim();
  const tags = row.surface_tags?.length ? ` surface_tags=[${row.surface_tags.join(", ")}] (carried for traceability only, never a decision input, per ADR-020 Amendment 1).` : "";
  const text = deriveSearchText(t, u);
  const source = !t && text ? `no title present, matched against document_url-derived text "${text}"` : `title "${t}"`;
  const celex = parseCelex(u) ?? parseCelex(t);
  const root = celex ? roots.find((r) => r.sector === celex.sector && r.year === celex.year && r.type === celex.type && r.number === celex.number) : undefined;
  if (celex && root) return { verdict: "off_vertical", rule: root.rule, basis: `CELEX ${celex.raw} decodes to ${root.label}: off-vertical by the number alone, independent of title "${t}".${tags}` };
  for (const r of rules) if (r.test.test(text) && !r.exclude?.test(text)) return { verdict: r.verdict, rule: r.name, basis: `Match basis (${source}): ${r.name} (${r.label}).${r.note}${tags}` };
  if (celex?.sector === "5") return { verdict: "ambiguous", rule: "celex_preparatory_act_no_title_signal", basis: `CELEX ${celex.raw} is sector 5 (a preparatory act, not yet enacted law) and no rule matched (${source}): held with a maximum age rather than dispositioned against a proposal that may still change.${tags}` };
  return { verdict: "ambiguous", rule: "no_signal_ambiguous", basis: `No ON or OFF rule matched title "${t || "(empty)"}" or document_url "${u || "(empty)"}"${!t && text ? ` (url-derived text "${text}" also matched nothing)` : ""}: held with a maximum age; ambiguous never auto-declines.${tags}` };
}

export interface ReviewedVerdict { verdict: ScreenVerdictName; basis: string; reviewer?: string | null }
/** One verdict per row: the rule's, except that a reviewed verdict (with a stated basis) replaces a rule's `ambiguous`. */
export function screenVerdictFor(row: { id?: string | null; title?: string | null; document_url?: string | null; surface_tags?: readonly string[] | null }, reviewed: ReadonlyMap<string, ReviewedVerdict> = new Map()): Screen {
  const r = classifyRelevance(row);
  const entry = row.id ? reviewed.get(row.id) : undefined;
  if (r.verdict === "ambiguous" && entry && entry.basis.length) return { verdict: entry.verdict, rule: null, basis: entry.basis, provenance: "reviewed" };
  return { verdict: r.verdict, rule: r.rule, basis: r.basis, provenance: "rule" };
}

/** The reviewed verdicts (screen_verdicts, one row per census id). A failed read throws: an unreadable table is never "no overrides". */
export async function loadReviewedVerdicts(sb: Db): Promise<Map<string, ReviewedVerdict>> {
  const rows = await fetchAllRows<{ census_id: string; verdict: ScreenVerdictName; basis: string; reviewer: string | null }>((from, to) => sb.from("screen_verdicts").select("census_id, verdict, basis, reviewer").order("census_id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  return new Map(rows.map((r) => [r.census_id, { verdict: r.verdict, basis: r.basis, reviewer: r.reviewer }]));
}

