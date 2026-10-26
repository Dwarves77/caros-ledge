// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the adapter from a stored row to the fact a detector reads (spec per table in data/facts.json), and the grade of a pattern's evidence. Pure: the same function builds the facts the connect stage detects over and the
// facts the propagation drain re-reads when an evidence row changes, so a pattern is recomputed by the code that found it.
import { couplingById } from "@/core/coupling/coupling";
import { findFigures, isFigure, statutoryUnit } from "@/core/parse";

import { FACT_SPECS, PATTERNS, UNIT_FORMS, type FactSpec } from "./config";
import type { Fact, FactRole } from "./types";

type Row = Record<string, unknown>;
const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const asNumber = (v: unknown): number | null => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const asDay = (v: unknown): string | null => (asText(v) && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
function plusMonths(d: string, months: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() + Math.round(months));
  return t.toISOString().slice(0, 10);
}

/** The spec of the table an evidence edge names, the one of the wanted role when the table is read as more than one (the edge table is the stored table, which is not always the one read: the research assessments are read through their current view). */
const specOfEdge = (table: string, role?: FactRole): { spec: FactSpec } | null => {
  const hits = Object.entries(FACT_SPECS).flatMap(([read, specs]) => specs.filter((s) => (s.edge ?? read) === table).map((spec) => ({ spec })));
  return hits.find((h) => h.spec.role === role) ?? hits[0] ?? null;
};

/** The fact a row is, or null when the table has no spec or the row is no fact of that role: a ceiling with no figure, one outside its [enforcement start, in-force end] window at `over.now` (an ended ceiling is no fact), a ratchet with neither a date nor a quantity.
 * `entities` are the entities the row is filed under; `over` carries what a row takes from its item: the surface it is read on and the day the item was added (a claim re-extracted by a backfill is no newer than its item), the role to read it as, the clock, and a claim's document date. */
export function factOf(table: string, row: Row, entities: readonly string[], over: { surface?: string | undefined; at?: string | null | undefined; role?: FactRole; now?: Date; docAt?: string | null } = {}): Fact | null {
  const hit = specOfEdge(table, over.role);
  if (!hit) return null;
  const s = hit.spec;
  const today = over.now?.toISOString().slice(0, 10);
  if (today && ((s.until && (asDay(row[s.until]) ?? "9") < today) || (s.from && (asDay(row[s.from]) ?? "0") > today))) return null;
  const at = over.at !== undefined ? over.at : s.at ? asDay(row[s.at]) : null;
  const figure = s.qty?.figure ? findFigures(String(row[s.qty.figure] ?? "")).map((h) => h.result).find(isFigure) : undefined;
  if (s.qty?.figure && !figure) return null;
  const rawQty = figure ? asNumber(figure.value) : s.qty?.column ? asNumber(row[s.qty.column]) : null;
  // a quantity that is compared (a ratchet's mandated quantity, a ceiling, a capacity, an abatement cost) is read in the canonical unit, the one map statutoryUnit holds; a unit it does not state leaves the quantity out and says so. A series keeps the unit it was observed in.
  const rawUnit = figure ? String(row[s.qty?.figure ?? ""] ?? "") : s.qty?.unit ?? (s.qty?.unitColumn ? asText(row[s.qty.unitColumn]) : null);
  const compared = ["ratchet", "ceiling", "capacity", "abatement"].includes(s.role);
  const canonical = compared && rawUnit ? statutoryUnit(rawUnit, UNIT_FORMS) : null;
  const unitUnknown = compared && rawQty !== null && canonical === null;
  const qty = unitUnknown ? null : rawQty;
  const year = s.dueYear && /^\d{4}$/.test(String(row[s.dueYear] ?? "")) ? String(row[s.dueYear]) : null;
  const due = s.due ? asDay(row[s.due]) : year ? `${year}-01-01` : s.dueMonthsAfterAt && at && asNumber(row[s.dueMonthsAfterAt]) !== null ? plusMonths(at, asNumber(row[s.dueMonthsAfterAt]) as number) : null;
  if (s.role === "ratchet" && due === null && qty === null) return null;
  return {
    table, pk: String(row[s.pk]), role: s.role, entities: [...entities], modes: [...new Set(entities.flatMap((e) => couplingById(e)?.modes ?? []))].sort(), surface: over.surface ?? s.surface ?? "unknown", at, due,
    source: s.source ? asText(row[s.source]) : null, tier: s.tier ? asNumber(row[s.tier]) : null, qty, unit: qty === null ? null : compared ? canonical : figure ? figure.unit : s.qty?.unit ?? (s.qty?.unitColumn ? asText(row[s.qty.unitColumn]) : null), ...(unitUnknown ? { unitUnknown: true } : {}), ...(table === "derived_values" && row.admissibility === "display_only" ? { displayOnly: true as const } : {}), trl: s.trl ? asNumber(row[s.trl]) : null,
    kind: s.kind ? asText(row[s.kind]) : null, group: s.group ? asText(row[s.group]) : null, item: s.owner ? asText(row[s.owner]) : null,
    ...(s.resolved && row[s.resolved] ? { resolved: true as const } : {}), ...(over.docAt !== undefined ? { docAt: over.docAt } : {}),
  };
}

/** analysis_ok when every rated piece of evidence is at the analysis tier or better and no derived value in it is display-grade, display_only when any is below it. */
export const gradeOf = (facts: readonly Pick<Fact, "tier" | "displayOnly">[]): "analysis_ok" | "display_only" => (facts.every((f) => !f.displayOnly && (f.tier === null || f.tier <= PATTERNS.analysisMaxTier)) ? "analysis_ok" : "display_only");
