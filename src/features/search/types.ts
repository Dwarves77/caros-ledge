// Ported from old_repo/src/app/api/search/logic.ts (lines 1-22)
// The search vocabulary both sides import: the limits and the row a hit is drawn from. No imports, so a client component can read it.
export const MIN_QUERY_LEN = 2;
/** The rpc clamps to 30; the results page shows the top 20. */
export const MAX_RESULTS = 20;

export interface SearchRow {
  id: string;
  title: string;
  item_type: string | null;
  domain: number | null;
  priority: string | null;
  jurisdictions: string[] | null;
  transport_modes: string[] | null;
  topic: string | null;
  /** The source's customer tier, or null when the item has no rated source. */
  tier: number | null;
}
/** A failed read says only that it failed (`reason`): the driver's message goes to the log in runSearch and never travels to the page (S:81). */
export type SearchOutcome<R> = { ok: true; rows: R[] } | { ok: false; reason: "unavailable" };
