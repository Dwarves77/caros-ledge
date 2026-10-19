// The inputs of a derivation are read through the admissible-row rule (I13, register flywheel:8): a method never computes from a superseded factor, an archived or unverified item, a suppressed claim, a stale
// or superseded derived value, or an inference a later one replaced. A row that is not current resolves to null, which every method refuses on. A failed read throws; it is never read as "not current".
import { readItemCorrections, suppressedClaimMatcher } from "@/core/corrections";
import type { Db } from "@/core/db";
import { qb } from "@/core/db/qb";

import { isAdmissibleFactor, isAdmissibleItem, isCurrentInference } from "./admissible";

type Row = Record<string, unknown>;
const DEAD_LIFECYCLES = new Set(["falsified", "obsolete", "superseded"]);

/** `row` when it is a current input of its table, else null. Tables with no notion of currency (append-only observations) pass through. */
export async function currentInputRow(sb: Db, table: string, row: Row | null): Promise<Row | null> {
  if (!row) return null;
  switch (table) {
    case "emission_factors":
      return isAdmissibleFactor(row) ? row : null;
    case "intelligence_items":
      return isAdmissibleItem(row) ? row : null;
    case "section_claim_provenance": {
      const itemId = String(row.intelligence_item_id ?? "");
      const item = await sb.from("intelligence_items").select("provenance_status, is_archived, replaced_by").eq("id", itemId).maybeSingle();
      if (item.error) throw new Error(`current input: intelligence_items read failed: ${item.error.message}`);
      if (!isAdmissibleItem(item.data as Row | null)) return null;
      return suppressedClaimMatcher(await readItemCorrections(sb, itemId), itemId)({ id: String(row.id), claim_text: String(row.claim_text ?? "") }) ? null : row;
    }
    case "derived_values":
      return row.admissibility === "stale" || DEAD_LIFECYCLES.has(String(row.lifecycle)) ? null : row;
    case "inference_records": {
      const next = await qb(sb.from("inference_records").select("inference_id").eq("supersedes", String(row.inference_id)).limit(1));
      if (next.error) throw new Error(`current input: inference_records read failed: ${next.error.message}`);
      return isCurrentInference({ inference_id: String(row.inference_id), admissibility: row.admissibility as string | null }, new Set((next.data ?? []).length > 0 ? [String(row.inference_id)] : [])) ? row : null;
    }
    default:
      return row;
  }
}
