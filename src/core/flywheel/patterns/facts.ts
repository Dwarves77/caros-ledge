// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the adapter from a stored row to the fact a detector reads (spec per table in data/facts.json), and the grade of a pattern's evidence. Pure: the same function builds the facts the connect stage detects over and the
// facts the propagation drain re-reads when an evidence row changes, so a pattern is recomputed by the code that found it.
import { couplingById } from "@/core/coupling/coupling";
import { findFigures, isFigure, statutoryUnit } from "@/core/parse";

import { FACT_SPECS, PATTERNS, UNIT_FORMS, type FactSpec } from "./config";
import type { Fact } from "./types";

type Row = Record<string, unknown>;
const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const asNumber = (v: unknown): number | null => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const asDay = (v: unknown): string | null => (asText(v) && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
function plusMonths(d: string, months: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() + Math.round(months));
  return t.toISOString().slice(0, 10);
}

/** The spec of the table an evidence edge names (the edge table is the stored table, which is not always the one read: the research assessments are read through their current view). */
const specOfEdge = (table: string): { read: string; spec: FactSpec } | null => {
  const hit = Object.entries(FACT_SPECS).find(([read, s]) => (s.edge ?? read) === table);
  return hit ? { read: hit[0], spec: hit[1] } : null;
};

/** The fact a row is, or null when the table has no spec. `entities` are the entities the row is filed under; `over` carries what a row takes from its item: the surface it is read on and the day the item was added (a claim re-extracted by a backfill is no newer than its item). */
export function factOf(table: string, row: Row, entities: readonly string[], over: { surface?: string | undefined; at?: string | null | undefined; docAt?: string | null | undefined } = {}): Fact | null {
  const hit = specOfEdge(table);
  if (!hit) return null;
  const s = hit.spec;
  const at = over.at !== undefined ? over.at : s.at ? asDay(row[s.at]) : null;
  const figure = s.qty?.figure ? findFigures(String(row[s.qty.figure] ?? "")).map((h) => h.result).find(isFigure) : undefined;
  const rawQty = figure ? asNumber(figure.value) : s.qty?.column ? asNumber(row[s.qty.column]) : null;
  // a quantity that is compared (a ratchet's maximum, a ceiling, a capacity, an abatement cost) is read in the canonical unit, the one map statutoryUnit holds; a unit it does not state leaves the quantity out and says so. A series keeps the unit it was observed in.
  const rawUnit = figure ? String(row[s.qty?.figure ?? ""] ?? "") : s.qty?.unit ?? (s.qty?.unitColumn ? asText(row[s.qty.unitColumn]) : null);
  const compared = ["ratchet", "ceiling", "capacity", "abatement"].includes(s.role);
  const canonical = compared && rawUnit ? statutoryUnit(rawUnit, UNIT_FORMS) : null;
  const unitUnknown = compared && rawQty !== null && canonical === null;
  const qty = unitUnknown ? null : rawQty;
  const due = s.due ? asDay(row[s.due]) : s.dueYear && asNumber(row[s.dueYear]) ? `${asNumber(row[s.dueYear])}-01-01` : s.dueMonthsAfterAt && at && asNumber(row[s.dueMonthsAfterAt]) !== null ? plusMonths(at, asNumber(row[s.dueMonthsAfterAt]) as number) : null;
  return {
    table, pk: String(row[s.pk]), role: s.role, entities: [...entities], modes: [...new Set(entities.flatMap((e) => couplingById(e)?.modes ?? []))].sort(), surface: over.surface ?? s.surface ?? "unknown", at, ...(over.docAt ? { docAt: over.docAt } : {}), due,
    source: s.source ? asText(row[s.source]) : null, tier: s.tier ? asNumber(row[s.tier]) : null, qty, unit: qty === null ? null : compared ? canonical : figure ? figure.unit : s.qty?.unit ?? (s.qty?.unitColumn ? asText(row[s.qty.unitColumn]) : null), ...(unitUnknown ? { unitUnknown: true } : {}), ...(table === "derived_values" && row.admissibility === "display_only" ? { displayOnly: true as const } : {}), trl: s.trl ? asNumber(row[s.trl]) : null,
    kind: s.kind ? asText(row[s.kind]) : null, group: s.group ? asText(row[s.group]) : null,
  };
}

/** analysis_ok when every rated piece of evidence is at the analysis tier or better and no derived value in it is display-grade, display_only when any is below it. */
export const gradeOf = (facts: readonly Pick<Fact, "tier" | "displayOnly">[]): "analysis_ok" | "display_only" => (facts.every((f) => !f.displayOnly && (f.tier === null || f.tier <= PATTERNS.analysisMaxTier)) ? "analysis_ok" : "display_only");
