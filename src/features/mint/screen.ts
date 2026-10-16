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
export function loadRules() {
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
export function parseCelex(text: string | null | undefined) {
  if (!text) return null;
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // not URL-encoded: use as-is
  }
  const m = CELEX_RE.exec(decoded);
  return m ? { raw: m[0], sector: m[1] ?? "", year: parseInt(m[2] ?? "0", 10), type: (m[3] ?? "").toUpperCase(), number: parseInt(m[4] ?? "0", 10) } : null;
}

/** The text every rule matches: the title, else a pseudo-title read from the document URL (a descriptive slug or filename). */
export function deriveSearchText(title: string | null | undefined, documentUrl: string | null | undefined): string {
  const t = String(title ?? "").trim();
  if (t) return t;
  const u = String(documentUrl ?? "");
  const filename = /[?&]filename=([^&]+)/i.exec(u)?.[1];
  let seg = filename ?? (u.split(/[?#]/)[0] ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
  try {
    seg = decodeURIComponent(seg);
  } catch {
    // not URL-encoded
  }
  return seg.replace(/\.(pdf|html?|aspx?|docx?)$/i, "").replace(/[_-]+/g, " ").replace(/\b(en|fr|de)\b$/i, "").trim();
}

export interface RuleVerdict { verdict: ScreenVerdictName; rule: string; basis: string }
/** Classify one census row for freight-sustainability relevance. surface_tags are carried for traceability only, never a decision input (ADR-020 Amendment 1). */
export function classifyRelevance(row: { title?: string | null; document_url?: string | null; surface_tags?: readonly string[] | null } = {}): RuleVerdict {
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
/** Only `on_vertical` mints. */
export const isMintable = (verdict: string | null | undefined): boolean => verdict === "on_vertical";

/** The reviewed verdicts (screen_verdicts, one row per census id). A failed read throws: an unreadable table is never "no overrides". */
export async function loadReviewedVerdicts(sb: Db): Promise<Map<string, ReviewedVerdict>> {
  const rows = await fetchAllRows<{ census_id: string; verdict: ScreenVerdictName; basis: string; reviewer: string | null }>((from, to) => sb.from("screen_verdicts").select("census_id, verdict, basis, reviewer").order("census_id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  return new Map(rows.map((r) => [r.census_id, { verdict: r.verdict, basis: r.basis, reviewer: r.reviewer }]));
}

export const ARCHIVE_REASON = "off_vertical";
export interface ReconcileResult { live: number; onVertical: number; offVertical: number; ambiguous: number; archived: number; ambiguousIds: string[] }
/** Archive (reversibly, reason off_vertical) the live record items the screen now rules off-vertical; ambiguous items stay live and are returned for the caller to hold. */
export async function reconcileRecordItems(sb: Db, reviewed: ReadonlyMap<string, ReviewedVerdict>, opts: { dry: boolean; today: string }): Promise<ReconcileResult> {
  const items = await fetchAllRows<{ id: string; title: string | null; source_url: string | null }>((from, to) => sb.from("intelligence_items").select("id, title, source_url").eq("item_grade", "record").eq("is_archived", false).order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 });
  const census = new Map<string, { id: string; title: string | null; surface_tags: string[] | null }>();
  const urls = [...new Set(items.map((i) => i.source_url).filter((x): x is string => !!x))];
  for (let i = 0; i < urls.length; i += 50) {
    const r = await sb.from("census_worklist").select("id, document_url, title, surface_tags").in("document_url", urls.slice(i, i + 50));
    if (r.error) throw new Error(`census read for reconcile failed: ${r.error.message}`);
    for (const c of (r.data ?? []) as { id: string; document_url: string; title: string | null; surface_tags: string[] | null }[]) if (!census.has(c.document_url)) census.set(c.document_url, c);
  }
  const verdicts = items.map((it) => {
    const c = it.source_url ? census.get(it.source_url) : undefined;
    return { id: it.id, v: screenVerdictFor({ id: c?.id ?? null, title: c?.title ?? it.title ?? "", document_url: it.source_url, surface_tags: c?.surface_tags ?? [] }, reviewed).verdict };
  });
  const off = verdicts.filter((x) => x.v === "off_vertical").map((x) => x.id);
  const ambiguousIds = verdicts.filter((x) => x.v === "ambiguous").map((x) => x.id);
  let archived = 0;
  if (!opts.dry) {
    for (let i = 0; i < off.length; i += 50) {
      const u = await sb.from("intelligence_items").update({ is_archived: true, archive_reason: ARCHIVE_REASON, archived_date: opts.today }).in("id", off.slice(i, i + 50)).eq("item_grade", "record").eq("is_archived", false).select("id");
      if (u.error) throw new Error(`reconcile archive failed: ${u.error.message}`);
      archived += (u.data ?? []).length;
    }
    if (archived !== off.length) throw new Error(`reconcile mismatch: ${off.length} off-vertical items, ${archived} archived`);
  }
  return { live: items.length, onVertical: verdicts.length - off.length - ambiguousIds.length, offVertical: off.length, ambiguous: ambiguousIds.length, archived, ambiguousIds };
}
