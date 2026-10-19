import { z } from "zod";

import { SOURCE_LICENCES } from "@/core/contracts/source-licence";

import documentsRaw from "./data/documents.json";
import adversarial from "./data/rows-adversarial.json";
import ecotransit from "./data/rows-ecotransit.json";
import euMaritime from "./data/rows-eu-maritime.json";
import ghgProtocol from "./data/rows-ghg-protocol.json";
import glec from "./data/rows-glec.json";
import otherRegimes from "./data/rows-other-regimes.json";
import recheck from "./data/rows-recheck.json";

const dec = z.string().regex(/^-?\d+(\.\d+)?$/);
const BOUNDARY = z.enum(["WTW", "WTT", "TTW", "not_stated", "not_applicable"]);
const GWP = z.enum(["AR4_100", "AR5_100", "AR6_100", "eu_del_reg_2020_1044", "not_stated", "not_applicable"]);
const FLAGS = z.enum(["source_unit_defect", "truncated_intermediate", "source_rounding", "mixed_locale_in_document", "locale_collision", "typed_missing", "extraction_loss"]);
const LOCALE = z.enum(["dp", "dc"]); // dp: decimal point, comma thousands. dc: decimal comma, space or dot thousands.

/** The value a printed literal stands for under its document's number locale (U1); null when it is not a plain number. */
export function parseLiteral(literal: string, locale: z.infer<typeof LOCALE>): string | null {
  const s = locale === "dp" ? literal.replace(/[, ]/g, "") : literal.replace(/[ .]/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

const quantity = z.object({
  name: z.string().min(1), unit: z.string().min(1).max(40), origin: z.enum(["printed", "derived", "constant"]).default("printed"),
  literal: z.string().max(40).optional(), locale: LOCALE.optional(), value: dec.optional(), text: z.string().max(60).optional(),
  missing: z.enum(["TBM", "N/A", "dash", "not_set", "M"]).optional(), rounded: z.boolean().optional(), sigDigits: z.number().int().positive().optional(), basis: z.string().max(120).optional(),
  attrs: z.record(z.string(), z.string().max(40)).optional(),
}).strict();
const output = quantity.extend({ boundary: BOUNDARY, gwp_set: GWP }).strict();
const side = z.object({ doc: z.string(), page: z.number().int().positive().optional(), tokens: z.array(z.string().max(40)).min(1), literal: z.string().max(40), locale: LOCALE, value: dec, gwp_set: GWP, document_date: z.string().max(60) }).strict();
const check = z.object({ doc: z.string(), page: z.number().int().positive().optional(), folio: z.string().max(12).optional(), section: z.string().max(80), tokens: z.array(z.string().max(40)), absent: z.array(z.string().max(30)).optional() }).strict();
const names = z.array(z.string()).min(1);
const relation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sum"), terms: names, total: z.string() }).strict(),
  z.object({ type: z.literal("wtw"), wtt: z.string(), ttw: z.string(), wtw: z.string() }).strict(),
  z.object({ type: z.literal("product"), factors: names, result: z.string(), scale: z.number().optional() }).strict(),
  z.object({ type: z.literal("quotient"), numerator: z.string(), denominator: z.string(), result: z.string() }).strict(),
]);
const documentSchema = z.object({ title: z.string(), publisher: z.string(), url: z.string().url(), format: z.enum(["pdf", "html"]), licence_keys: z.array(z.string()), published: z.string().optional(), note: z.string().optional() }).strict();

const row = z.object({
  id: z.string().regex(/^[A-Z]\d+$/), kind: z.enum(["truth", "adversarial", "locale_collision", "disagreement", "rule", "recheck"]), framework: z.string(), framework_version: z.string(),
  recheck_against: z.string().optional(), illustrative: z.boolean().default(false), status: z.enum(["verified", "unresolved"]), unresolved_reason: z.string().optional(),
  state: z.enum(["ok", "sources_disagree", "not_determinable"]).default("ok"), flags: z.array(FLAGS).default([]), categories: z.record(z.string(), z.string()).optional(),
  retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), checks: z.array(check), inputs: z.array(quantity), outputs: z.array(output), relations: z.array(relation).default([]),
  traps: z.array(z.object({ what: z.string().max(320), wrong_value: z.string().max(40).optional() }).strict()), disagreements: z.array(z.object({ figure: z.string(), sides: z.array(side).min(2) }).strict()).default([]),
}).strict();
export type GoldenRow = z.infer<typeof row>;
export type GoldenOutput = z.infer<typeof output>;
export type GoldenDocument = z.infer<typeof documentSchema>;

export const DOCUMENTS: Readonly<Record<string, GoldenDocument>> = z.record(z.string(), documentSchema).parse(documentsRaw);
const RANK = ["permitted", "conditional", "unverified", "prohibited"];
/** The worst register verdict over the document's licence keys; a document with no register entry is `terms_unverified`, never assumed open. */
export function licenceClass(doc: string): "permitted" | "conditional" | "terms_unverified" | "prohibited" {
  const keys = DOCUMENTS[doc]?.licence_keys ?? [];
  if (!keys.length) return "terms_unverified";
  const worst = keys.map((k) => RANK.indexOf(SOURCE_LICENCES[k]?.redistribution ?? "prohibited")).reduce((a, b) => Math.max(a, b));
  return worst === 2 ? "terms_unverified" : (RANK[worst] as "permitted" | "conditional" | "prohibited");
}

/** Parse rows and refuse the ones that cannot be truth: a guessed value (INV-R6a-1), a missing GWP set or boundary, an unlinked derived value, a verified row with no locator. */
export function parseRows(raw: unknown[]): GoldenRow[] {
  const rows = z.array(row).parse(raw);
  const seen = new Set<string>();
  for (const r of rows) {
    const bad = (m: string): never => { throw new Error(`${r.id}: ${m}`); };
    if (seen.has(r.id)) bad("duplicate id");
    seen.add(r.id);
    for (const c of [...r.checks, ...r.disagreements.flatMap((d) => d.sides)]) if (!DOCUMENTS[c.doc]) bad(`unknown document ${c.doc}`);
    if (r.status === "unresolved") { if (!r.unresolved_reason || r.outputs.length) bad("an unresolved row states its reason and carries no expected value"); continue; }
    for (const d of r.disagreements) for (const x of d.sides) if (parseLiteral(x.literal, x.locale) !== x.value || !x.tokens.some((t) => t.includes(x.literal))) bad(`${d.figure}: a disagreement side states a literal that is on its locator and parses to its value`);
    const tokens = [...r.checks.flatMap((c) => c.tokens), ...r.disagreements.flatMap((d) => d.sides.flatMap((s) => s.tokens))];
    if (!r.checks.length || r.checks.some((c) => !c.tokens.length && !c.absent?.length)) bad("a verified row cites a locator with probe tokens");
    if ((r.state === "sources_disagree") !== (r.disagreements.length > 0)) bad("state sources_disagree and disagreements go together");
    const results = new Set(r.relations.flatMap((x) => (x.type === "sum" ? [x.total] : x.type === "wtw" ? [x.wtw] : [x.result])));
    for (const q of [...r.inputs, ...r.outputs]) {
      const n = [q.value, q.text, q.missing].filter((v) => v !== undefined).length;
      if (n !== 1) bad(`${q.name} carries exactly one of value, text, missing`);
      if (q.missing && (q.origin !== "printed" || !q.literal)) bad(`${q.name}: a typed missing is printed and never a value (never zero-fill)`);
      if (q.origin !== "printed" && !q.basis) bad(`${q.name}: a ${q.origin} value states its basis`);
      if (q.origin === "derived" && q.value !== undefined && !results.has(q.name)) bad(`${q.name}: a derived value is the result of a stated relation`);
      if (q.origin === "printed" && q.value !== undefined) {
        if (!q.literal || !q.locale || !q.sigDigits) bad(`${q.name}: a printed value carries literal, locale and sigDigits`);
        if (parseLiteral(q.literal!, q.locale!) !== q.value) bad(`${q.name}: value ${q.value} is not the literal ${q.literal} under ${q.locale}`);
        if (q.sigDigits! > q.literal!.replace(/\D/g, "").length) bad(`${q.name}: sigDigits exceeds the printed digits`);
      }
      if (q.origin === "printed" && q.literal && !tokens.some((t) => t.includes(q.literal!))) bad(`${q.name}: the printed literal ${q.literal} is on no cited locator`);
    }
    for (const o of r.outputs) if (/CO2e/.test(o.unit) && o.gwp_set === "not_applicable") bad(`${o.name}: a CO2e figure names its GWP set`);
  }
  return rows;
}

export const ROWS: readonly GoldenRow[] = parseRows([ghgProtocol, glec, ecotransit, euMaritime, otherRegimes, adversarial, recheck].flat());

/** INV-R6a-4: two figures compare only under one GWP set and one boundary; anything else is a series break the loader refuses. */
export function compareOutputs(a: GoldenOutput, b: GoldenOutput): { ok: true; equal: boolean } | { ok: false; reason: "series_break_gwp" | "series_break_boundary" | "unit" | "no_value" } {
  if (a.value === undefined || b.value === undefined) return { ok: false, reason: "no_value" };
  if (a.gwp_set !== b.gwp_set || a.gwp_set === "not_stated") return { ok: false, reason: "series_break_gwp" };
  if (a.boundary !== b.boundary || a.boundary === "not_stated") return { ok: false, reason: "series_break_boundary" };
  return a.unit === b.unit ? { ok: true, equal: Number(a.value) === Number(b.value) } : { ok: false, reason: "unit" };
}
