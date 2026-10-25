// DERIVE-2 V3: the backfill inside the turn. Objects whose mode, statutory maximum or cost formula is still null get them from their own verbatim span (and, for the mode, their instrument's title): an UPDATE of the null columns only, never a
// non-null, with the span and version untouched (the guard re-proves the span on the update). One bounded batch per turn, by obligation_id after a cursor the turn's ledger row carries (outputs.ids.derive_cursor = [last id, derivation
// version]; a short batch or a new version wraps to the start), so an object that classifies to nothing is not re-read every turn. The same classifiers run in dutyCandidate, so a new object is born filled.
import { z } from "zod";

import { fetchAllByIdChunks, type Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import type { RunResult } from "@/core/types/run-result";

import rulesJson from "./data/object-rules.json";
import { OBJECT_DERIVATION_VERSION } from "./derive-objects";
import { extractStatutory } from "./maximum";
import { classifyMode } from "./mode";

/** The one value `input.derive.only` may carry in this slice. */
export const FILL_ONLY = "modes-and-maximum";
const fill = z.object({ batch: z.number().int().positive(), absence: z.string().min(1) }).parse({ batch: rulesJson.fill.batch, absence: rulesJson.absence });

export interface FillRow { obligation_id: string; instrument_item_id: string; verbatim_text: string; mode: string[] | null; statutory_maximum: string | null; cost_formula: string | null }
/** One object's plan: the columns to write (only those that are null and now have a grounded value) and what the classifiers said. `modeAbsence` is the stated absence token for the plan row; a text[] cannot hold it, so the table gets null. */
export interface FillPlanRow {
  obligation_id: string;
  patch: { mode?: string[]; statutory_maximum?: string; cost_formula?: string };
  modeRules: string[];
  modeFrom: "span" | "instrument" | null;
  consignmentWide: boolean;
  modeAbsence: string | null;
  unit: string | null;
  refused: string[];
}

/** Pure: what to write for one object. A non-null column is never in the patch. */
function planFill(row: FillRow, instrument: { title?: string | null | undefined; identifier?: string | null | undefined }): FillPlanRow {
  const verdict = classifyMode(row.verbatim_text, instrument);
  const stated = extractStatutory(row.verbatim_text);
  const patch: FillPlanRow["patch"] = {
    ...(row.mode === null && verdict.modes.length ? { mode: verdict.modes } : {}),
    ...(row.statutory_maximum === null && stated.maximum ? { statutory_maximum: stated.maximum.fragment } : {}),
    ...(row.cost_formula === null && stated.formula ? { cost_formula: stated.formula.fragment } : {}),
  };
  return { obligation_id: row.obligation_id, patch, modeRules: verdict.ruleIds, modeFrom: verdict.from, consignmentWide: verdict.consignmentWide, modeAbsence: row.mode === null && !verdict.modes.length ? fill.absence : null, unit: stated.maximum?.unit ?? null, refused: stated.refused };
}

/** The id the next batch starts after, from the last turn's cursor; null (start) when there is none, it wrapped, or the derivation version changed. */
export const cursorAfter = (ids: readonly string[] | undefined): string | null => (ids && ids.length === 2 && ids[1] === OBJECT_DERIVATION_VERSION ? (ids[0] as string) : null);

export async function fillObjectFields(sb: Db, input: { dry: boolean; batch?: number; after: string | null }): Promise<RunResult<{ plan: FillPlanRow[]; ids: { derive_cursor: string[] } }>> {
  const batch = input.batch ?? fill.batch;
  let q = sb.from("obligation_objects").select("obligation_id, instrument_item_id, verbatim_text, mode, statutory_maximum, cost_formula").or("mode.is.null,statutory_maximum.is.null,cost_formula.is.null").order("obligation_id", { ascending: true }).limit(batch);
  if (input.after) q = q.gt("obligation_id", input.after);
  const read = await q;
  if (read.error) return { counts: {}, outcome: "failed", notes: [`derive: obligation_objects read failed: ${read.error.message}`] };
  const rows = (read.data ?? []) as FillRow[];
  const items = await fetchAllByIdChunks<{ id: string; title: string | null; instrument_identifier: string | null }>(rows.map((r) => r.instrument_item_id), async (slice) => {
    const { data, error } = await admitItems(sb.from("intelligence_items").select("id, title, instrument_identifier").in("id", slice));
    if (error) throw new Error(`derive: intelligence_items read failed: ${error.message}`);
    return data ?? [];
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const plan = rows.map((r) => planFill(r, { title: byId.get(r.instrument_item_id)?.title, identifier: byId.get(r.instrument_item_id)?.instrument_identifier }));
  const counts: Record<string, number> = { scanned: rows.length, mode_set: 0, mode_from_title: 0, mode_unmatched: plan.filter((p) => p.modeAbsence !== null).length, maximum_set: 0, formula_set: 0, refused: 0, updated: 0 };
  const reasons = new Map<string, number>();
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  for (const p of plan) {
    if (p.patch.mode) { bump("mode_set"); p.patch.mode.forEach((m) => bump(`mode_set_${m}`)); if (p.modeFrom === "instrument") bump("mode_from_title"); if (p.consignmentWide) bump("mode_consignment_wide"); }
    if (p.patch.statutory_maximum) bump("maximum_set");
    if (p.patch.cost_formula) bump("formula_set");
    for (const why of p.refused) { bump("refused"); reasons.set(why.split(":")[0] as string, (reasons.get(why.split(":")[0] as string) ?? 0) + 1); }
  }
  const cursor = rows.length < batch ? [] : [rows[rows.length - 1]?.obligation_id as string, OBJECT_DERIVATION_VERSION];
  const notes = [...reasons].map(([why, n]) => `refused ${why}: ${n}`);
  const result = (outcome: RunResult["outcome"]) => ({ counts, outcome, notes, data: { plan, ids: { derive_cursor: cursor } } });
  if (input.dry) return result("ok");
  // Rows with the same patch are written together, each only where its own columns are still null; a group the guard refuses is retried row by row so one bad capture refuses one object.
  const groups = new Map<string, { patch: FillPlanRow["patch"]; ids: string[] }>();
  for (const p of plan.filter((x) => Object.keys(x.patch).length)) {
    const key = JSON.stringify(p.patch);
    groups.set(key, { patch: p.patch, ids: [...(groups.get(key)?.ids ?? []), p.obligation_id] });
  }
  let rowFailures = 0;
  const write = async (patch: FillPlanRow["patch"], ids: string[]) => {
    let u = sb.from("obligation_objects").update(patch).in("obligation_id", ids);
    for (const col of Object.keys(patch)) u = u.is(col, null);
    return u.select("obligation_id");
  };
  for (const { patch, ids } of groups.values()) {
    const whole = await write(patch, ids);
    if (!whole.error) { counts.updated = (counts.updated ?? 0) + (whole.data ?? []).length; continue; }
    for (const id of ids) {
      const one = await write(patch, [id]);
      if (one.error) { bump("refused"); rowFailures += 1; notes.push(`refused ${id}: ${one.error.message}`); } else counts.updated = (counts.updated ?? 0) + (one.data ?? []).length;
    }
  }
  return result(rowFailures ? "partial" : "ok");
}
