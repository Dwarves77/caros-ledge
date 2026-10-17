// Ported from old_repo/src/lib/detail/load-detail-core.ts (lines 134-225)
// The rating drawn on a fact (INV-080, INV-175, INV-213, INV-270): a grounded FACT claim's tier is its source's COALESCE(tier_override, base_tier), never effective_tier (which never confers grounding),
// and a claim an admin suppressed is absent from the map and from the render. One read of the item's claims serves both. The reader is the caller's own client: a member reads the claims through
// the member policy and the suppressions through the `fact_suppressions` view (0031), so a page renders without the service role. A failed read throws; the caller says so, nothing renders unredacted.
import { suppressedClaimMatcher, type Correction } from "@/core/corrections";
import type { Db } from "@/core/db";
import { boundedRead, fetchAllRows } from "@/core/db/query";
import type { ClaimTierMap } from "@/ui";

/** The claim columns the detail page needs, with the source row that grounds the claim. */
const CLAIM_SELECT = "id, claim_text, section_row_id, sources(name, url, base_tier, tier_override)";
const CLAIM_CAP = 5000;

interface SourceRow {
  name: string | null;
  url: string | null;
  base_tier: number | null;
  tier_override: number | null;
}
export interface ClaimRow {
  id: string;
  claim_text: string;
  section_row_id: string | null;
  sources: SourceRow | SourceRow[] | null;
  [k: string]: unknown;
}
export interface SuppressedClaimRef {
  id: string;
  claim_text: string;
  section_row_id: string | null;
  item_id: string;
}

/** The map from a claim's text to its rating: the source's override, else its base tier (null when the claim has no source). */
export function buildClaimTierMap(rows: readonly ClaimRow[] | null | undefined): ClaimTierMap {
  const map: ClaimTierMap = {};
  for (const row of rows ?? []) {
    if (!row || typeof row.claim_text !== "string") continue;
    const src = Array.isArray(row.sources) ? (row.sources[0] ?? null) : row.sources;
    map[row.claim_text] = { tier: src ? (src.tier_override ?? src.base_tier ?? null) : null, sourceName: src?.name ?? null, sourceUrl: src?.url ?? null };
  }
  return map;
}

/** The active fact suppressions of one item, as the view exposes them. Throws on a failed read. */
export async function readFactSuppressions(db: Db, itemUuid: string): Promise<Correction[]> {
  const read = await boundedRead((n) => db.from("fact_suppressions").select("id, item_id, target_kind, target_ref, op, machine_value, created_at, revoked_at").eq("item_id", itemUuid).limit(n), { limit: 200 });
  if (read.error) throw new Error(`fact_suppressions read failed: ${read.error.message}`);
  if (read.truncated) throw new Error(`fact_suppressions for ${itemUuid} reached its bound; suppression would be incomplete`);
  return read.data as unknown as Correction[];
}

/** The item's FACT claims split into the visible ones (the tier map) and the suppressed ones (to redact from the text). Throws on any failed read (INV-270: fail closed, never render unredacted). */
export async function readClaims(db: Db, itemUuid: string): Promise<{ tiers: ClaimTierMap; suppressed: SuppressedClaimRef[] }> {
  const [rows, suppressions] = await Promise.all([
    fetchAllRows<ClaimRow>((from, to) => db.from("section_claim_provenance").select(CLAIM_SELECT).eq("intelligence_item_id", itemUuid).eq("claim_kind", "FACT").order("id", { ascending: true }).range(from, to) as never, { pageSize: 500, cap: CLAIM_CAP }),
    readFactSuppressions(db, itemUuid),
  ]);
  const isSuppressed = suppressedClaimMatcher(suppressions, itemUuid);
  const visible = rows.filter((r) => !isSuppressed(r));
  return {
    tiers: buildClaimTierMap(visible),
    suppressed: rows.filter((r) => isSuppressed(r)).map((r) => ({ id: r.id, claim_text: r.claim_text, section_row_id: r.section_row_id, item_id: itemUuid })),
  };
}

/** The tier map alone (the name the other detail surfaces import). */
export const fetchClaimTierMap = async (db: Db, itemUuid: string): Promise<ClaimTierMap> => (await readClaims(db, itemUuid)).tiers;
