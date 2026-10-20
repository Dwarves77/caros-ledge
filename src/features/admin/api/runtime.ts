// Ported from old_repo/src/app/admin/page.tsx (lines 51-103)
// Ported from old_repo/src/app/admin/inferences/page.tsx (lines 10-71)
// Ported from old_repo/src/app/admin/factors/page.tsx (lines 61-120)
import { allRows, boundedRead, exactCount, qb, rowsByIds } from "@/core/db";
import type { Db } from "@/core/db";
import { HttpError, LookupError } from "@/core/http/errors";

import { adminRoute, reply } from "./shared";

const ERROR_GROUPS_BOUND = 50;

/** The current rows of a set holding whole chains: a row is current when no other row names it in `supersedes` (a recompute inserts a new row pointing at the old one, so the head is the row nothing points at). Pure. */
function currentRows<T extends { inference_id: string; supersedes?: string | null }>(rows: readonly T[]): T[] {
  const superseded = new Set(rows.map((r) => r.supersedes).filter((s): s is string => !!s));
  return rows.filter((r) => !superseded.has(r.inference_id));
}

async function readErrorGroups(db: Db) {
  const r = await boundedRead<Record<string, unknown>>((n) => db.from("error_events").select("id, message, count, release, side, route, env, last_seen_at, occurred_at").order("last_seen_at", { ascending: false }).order("id", { ascending: true }).limit(n), { limit: ERROR_GROUPS_BOUND });
  if (r.error) throw new LookupError("error_events", r.error);
  return r.data;
}
const readAssumptions = (db: Db) => allRows<Record<string, unknown>>(db, "assumption_register", "id, assumption_key, subsystem, label, value_numeric, unit, derivation, origin_class, governing_decision, code_location, status, as_at_date", { order: "id" });

export async function readInferences(db: Db) {
  const all = await allRows<{ inference_id: string; supersedes: string | null; cited_item_ids: string[] | null } & Record<string, unknown>>(db, "inference_records", "inference_id, subject_id, claim_text, status_token, confidence, cited_item_ids, origin_class, trigger_question_ref, computed_at, supersedes", { order: "inference_id" });
  const rows = currentRows(all).sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)));
  const items = await rowsByIds<{ id: string; title: string | null }>(db, "intelligence_items", "id, title", rows.flatMap((r) => r.cited_item_ids ?? []));
  return { rows, itemTitles: Object.fromEntries(items.map((i) => [i.id, i.title ?? i.id])) };
}

/** One read for the factors page and its tile: every emission factor row with its licence, live and superseded. */
export const readFactors = (db: Db) => allRows<Record<string, unknown>>(db, "emission_factors", "factor_id, tier, scope_kind, mode, vehicle_class, energy_carrier, jurisdiction, operator_key, corridor_id, quantity_basis, wtt_co2e, ttw_co2e, wtw_co2e, gwp_basis, derivation, origin_class, pedigree, method_version, as_at_date, valid_from, valid_to, superseded_by, source_key, data_sources(name, licence, redistribution, embeddable)", { order: "factor_id" });

/** The runtime views the console shows read-only: error groups, the assumption register, and the current inferences. */
export const GET = adminRoute("/api/admin/runtime", async (admin, request) => {
  const view = new URL(request.url).searchParams.get("view");
  const db = admin.service();
  if (view === "errors") return reply(admin, { groups: await readErrorGroups(db) });
  if (view === "assumptions") return reply(admin, { rows: await readAssumptions(db) });
  if (view === "inferences") return reply(admin, await readInferences(db));
  throw new HttpError(400, "view must be one of: errors, assumptions, inferences");
});

/** The live (not superseded) emission-factor count for the console tile. */
export const countLiveFactors = (db: Db) => exactCount(qb(db.from("emission_factors").select("factor_id", { count: "exact", head: true })).is("superseded_by", null));
