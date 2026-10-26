// Ported from old_repo/src/app/api/search/logic.ts (lines 1-98)
// Ported from old_repo/src/app/api/ask/route.ts (lines 260-283)
// THE retrieval: the ranked full-text hits of search_intelligence_items, re-fetched with the customer read gate and kept in rank order, on the CALLER's client (SEC-10: row security binds every
// entry point alike). The command bar, the results page, the portfolio add card and the Assistant all call this one function. A failed read is a stated failure, never an empty list (INV-263).
import type { Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import { refusal, type Refusal } from "@/core/http/failure";
import { log } from "@/core/shared/log";
import { customerTierOf } from "@/core/sources";

import { MAX_RESULTS, type SearchOutcome, type SearchRow } from "./types";

export { MAX_RESULTS, MIN_QUERY_LEN } from "./types";
export type { SearchOutcome, SearchRow } from "./types";

/** The columns a result row draws, with the rating of the row's own source (INV-213: the tier is the source's, never derived from the text). */
const RESULT_SELECT = "id, title, item_type, domain, priority, jurisdictions, jurisdiction_iso, what_is_it, source:sources!source_id(base_tier, effective_tier, tier_override)";


interface Embedded {
  base_tier: number | null;
  effective_tier: number | null;
  tier_override: number | null;
}
type Raw = Omit<SearchRow, "tier"> & { source?: Embedded | Embedded[] | null };

/** The tier of an embedded source (the embed may arrive as one object or a one-element list). */
export const embeddedTier = (source: Embedded | Embedded[] | null | undefined): number | null => {
  const one = Array.isArray(source) ? source[0] : source;
  return one ? customerTierOf(one) : null;
};

const failed = (what: string, message: string): Refusal => (log.warn(`[search] ${what} read failed:`, message), refusal("search_unavailable"));

/** The hits for `q`, best first. `select` is the row shape (default: the result row); the rows keep the rpc's rank order and carry only items that pass the read gate. */
export async function runSearch<R = SearchRow>(db: Db, q: string, opts: { maxRows?: number; select?: string; shape?: (raw: Record<string, unknown>) => R } = {}): Promise<SearchOutcome<R>> {
  const limit = Math.min(Math.max(1, opts.maxRows ?? MAX_RESULTS), MAX_RESULTS);
  const { data: hits, error } = await db.rpc("search_intelligence_items", { q, max_rows: limit });
  if (error) return failed("search_intelligence_items", error.message);
  const ids = ((hits ?? []) as { id: string }[]).map((h) => h.id);
  if (ids.length === 0) return { ok: true, rows: [] };
  const { data, error: rowError } = await admitItems(db.from("intelligence_items").select(opts.select ?? RESULT_SELECT)).in("id", ids);
  if (rowError) return failed("intelligence_items", rowError.message);
  const byId = new Map(((data ?? []) as unknown as Record<string, unknown>[]).map((r) => [String(r.id), r]));
  const shape = opts.shape ?? ((r: Record<string, unknown>) => { const { source, ...rest } = r as Raw & Record<string, unknown>; return { ...rest, tier: embeddedTier(source) } as unknown as R; });
  return { ok: true, rows: ids.flatMap((id) => (byId.has(id) ? [shape(byId.get(id) as Record<string, unknown>)] : [])) };
}
