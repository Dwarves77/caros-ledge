import { MemDb, type Row } from "../_support/memdb.ts";
import { installWorkspaceReadRpcs } from "../_support/workspace-reads.ts";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const USER = "bbbbbbbb-0000-4000-8000-000000000002";
export const NOW = new Date("2026-10-15T12:00:00.000Z");
export const S1 = "a1000000-0000-4000-8000-000000000001";
export const ID = { a: "a0000000-0000-4000-8000-00000000000a", b: "a0000000-0000-4000-8000-00000000000b", c: "a0000000-0000-4000-8000-00000000000c", d: "a0000000-0000-4000-8000-00000000000d", e: "a0000000-0000-4000-8000-00000000000e" };

const item = (id: string, over: Row): Row => ({ id, legacy_id: null, summary: "", item_type: "regulation", domain: 1, priority: "HIGH", provenance_status: "verified", is_archived: false, source_id: S1, jurisdictions: ["EU"], jurisdiction_iso: ["EU"], transport_modes: ["ocean"], added_date: "2026-01-01", verticals: [], ...over });

/** The workspace the dashboard reads: five items (one unverified, one archived by this workspace), a changelog entry, a cadence of off. */
export function dashboardWorld(): MemDb {
  const db = new MemDb({}, {});
  db.now = NOW.toISOString();
  db.seed("system_state", [{ id: true, scrape_cadence: "off", scrape_start_date: null, global_processing_paused: false }]);
  db.seed("sources", [{ id: S1, name: "EUR-Lex", url: "https://eur-lex.europa.eu/", base_tier: 1, tier_override: null, effective_tier: null, status: "active" }]);
  db.seed("intelligence_items", [
    item(ID.a, { title: "Alpha emissions regulation", priority: "CRITICAL", compliance_deadline: "2026-11-01", added_date: "2026-10-14", verticals: ["fine-art"], item_grade: "record" }),
    item(ID.b, { title: "Bravo market signal", item_type: "market_signal", domain: 2, priority: "HIGH", added_date: "2026-09-01", item_grade: "brief" }),
    item(ID.c, { title: "Charlie not yet verified", provenance_status: "quarantined", added_date: "2026-10-14" }),
    item(ID.d, { title: "Delta archived for the workspace", added_date: "2026-10-14" }),
    item(ID.e, { title: "Echo updated brief", priority: "MODERATE", added_date: "2026-01-01" }),
  ]);
  db.seed("workspace_item_overrides", [{ id: "o1", org_id: ORG, item_id: ID.d, is_archived: true, priority_override: null }]);
  db.seed("item_timelines", [{ id: "t1", item_id: ID.b, milestone_date: "2026-12-15", label: "Phase two", is_completed: false, sort_order: 1 }]);
  db.seed("item_changelog", [{ id: "c1", item_id: ID.e, change_date: "2026-10-10", change_type: "UPDATED", field: "full_brief", new_value: "batch-1" }]);
  return installWorkspaceReadRpcs(db);
}
