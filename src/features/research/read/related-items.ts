// Ported from old_repo/src/app/research/[slug]/page.tsx (lines 18-44)
// Ported from old_repo/src/app/research/[slug]/page.tsx (lines 128-196)
// Ported from old_repo/src/app/operations/[slug]/page.tsx (lines 27-53)
// Ported from old_repo/src/app/operations/[slug]/page.tsx (lines 127-206)
// The ONE related-items read of a detail page (the research and operations pages each wrote the same two-query cascade): the items matching the caller's rule first, the items from the same source second, five at
// most, verified and not archived. A failed read is returned as failed, never as "nothing related".
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { qb, type Qb } from "@/core/db/qb";
import { log } from "@/core/shared/log";

export const RELATED_LIMIT = 5;
export interface RelatedItem {
  id: string;
  title: string;
  summary: string | null;
  sourceName: string | null;
  addedDate: string | null;
}
export interface RelatedResult {
  items: RelatedItem[];
  /** Which rule found them: the caller's match, the shared source, or neither. */
  reason: "match" | "source" | "none";
  failed: boolean;
}
interface Row {
  id: string;
  legacy_id: string | null;
  title: string;
  summary: string | null;
  added_date: string | null;
  source_id: string | null;
}

/** `match` narrows the first query to the caller's rule (a theme, a jurisdiction overlap and an item type); null skips straight to the shared source. */
export async function relatedItems(db: Db, self: { id: string; sourceId: string | null }, match: ((q: Qb<Row>) => Qb<Row>) | null): Promise<RelatedResult> {
  const read = async (narrow: (q: Qb<Row>) => Qb<Row>): Promise<Row[]> => {
    const q = qb<Row>(admitItems(db.from("intelligence_items").select("id, legacy_id, title, summary, added_date, source_id")).neq("id", self.id));
    const { data, error } = await narrow(q).order("added_date", { ascending: false }).order("id", { ascending: true }).limit(RELATED_LIMIT);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  try {
    let reason: RelatedResult["reason"] = "match";
    let rows = match ? await read(match) : [];
    if (rows.length === 0 && self.sourceId) {
      reason = "source";
      rows = await read((q) => q.eq("source_id", self.sourceId as string));
    }
    if (rows.length === 0) return { items: [], reason: "none", failed: false };
    const ids = [...new Set(rows.map((r) => r.source_id).filter((x): x is string => !!x))];
    const names = new Map<string, string | null>();
    if (ids.length) {
      const { data, error } = await db.from("sources").select("id, name").in("id", ids);
      if (error) throw new Error(error.message);
      for (const s of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(s.id, s.name);
    }
    return { items: rows.map((r) => ({ id: r.legacy_id || r.id, title: r.title, summary: r.summary, sourceName: r.source_id ? (names.get(r.source_id) ?? null) : null, addedDate: r.added_date })), reason, failed: false };
  } catch (e) {
    log.warn("[related-items] the read failed:", e instanceof Error ? e.message : String(e));
    return { items: [], reason: "none", failed: true };
  }
}
