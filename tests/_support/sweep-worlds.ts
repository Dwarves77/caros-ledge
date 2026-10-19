// The world behind the page sweep for the workspace surfaces (Dashboard, watchlist, Search, Settings, Regulations, Market Intel, Research, Operations): the workspace's seeded organisation, members and items (one per surface
// beyond the two regulations, each with a timeline) over the one memory database (tests/_support/memdb.ts), the database's read functions as stand-ins (workspace-reads.ts), the list functions answering the seeded items of
// their surface, and a signed-in member as the client every page draws with. `memberWorld()` is a new world each call, scripted as the page's user client; the world names what a draw read and refuses a read by name.
import { ITEM_1, ITEM_2, seed, USER } from "../workspace/_world.ts";

import { scripted } from "./fake-clients.ts";
import { MemDb, type Row } from "./memdb.ts";
import type { SweepWorld } from "./page-sweep.ts";
import { installWorkspaceReadRpcs } from "./workspace-reads.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = "11111111-1111-4111-8111-111111111111";
/** One verified item per other surface, so a draw reads their rows and their timelines as well as an empty list. */
const EXTRA: Row[] = [
  { id: "aaaaaaaa-0000-4000-8000-000000000011", legacy_id: "m1", title: "EU ETS allowance price", item_type: "market_signal", domain: 4, provenance_status: "verified", is_archived: false, priority: "HIGH", origin_class: "official" },
  { id: "aaaaaaaa-0000-4000-8000-000000000012", legacy_id: "r1", title: "Green corridor feasibility study", item_type: "research_finding", domain: 7, provenance_status: "verified", is_archived: false, priority: "MODERATE", origin_class: "official" },
  { id: "aaaaaaaa-0000-4000-8000-000000000013", legacy_id: "o1", title: "Rotterdam shore power", item_type: "regional_data", domain: 3, provenance_status: "verified", is_archived: false, priority: "MODERATE", origin_class: "official" },
];
const SURFACE_DOMAINS: Record<string, number[]> = { get_workspace_intelligence_listings: [1], get_workspace_intelligence_listings_public: [1], get_market_intel_items_public: [2, 4], get_research_items_public: [7], get_operations_items_public: [3, 6] };

/** The member's client over the database: the signed-in claims, and an rpc the page can range (PostgREST's rpc builder is chainable; the stand-in answers the whole list for any range). */
function memberClient(db: MemDb): Any {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "auth") return { getClaims: async () => ({ data: { claims: { sub: USER.member, email: "member@example.test" } }, error: null }) };
      if (prop === "rpc") {
        return (name: string, args?: Record<string, unknown>) => {
          const call = target.rpc(name, args);
          return Object.assign(call, { range: () => call });
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The one portfolio of the sweep world: it holds both seeded regulations, so its detail page reads members, items and their roll-ups. */
export const PORTFOLIO = "99999999-0000-4000-8000-000000000001";
const portfolioRows = (): Record<string, Row[]> => ({
  portfolios: [{ id: PORTFOLIO, org_id: ORG, name: "Core book", name_key: "core book", created_at: "2026-10-01T00:00:00Z" }],
  portfolio_members: [ITEM_1, ITEM_2].map((id, i) => ({ id: `99999999-0000-4000-8000-0000000000${i + 10}`, portfolio_id: PORTFOLIO, org_id: ORG, member_kind: "item", item_id: id, entity_id: null, added_at: "2026-10-02T00:00:00Z" })),
});

const listRow = (i: Row): Row => ({ id: i.id, legacy_id: i.legacy_id, title: i.title, item_type: i.item_type, domain: i.domain, effective_priority: i.priority, added_date: "2026-10-01", full_brief: "x".repeat(60), source_id: null, effective_archived: false });

export function memberWorld(): SweepWorld & { db: MemDb } {
  const base = seed();
  const items = [...(base.tables.intelligence_items ?? []), ...EXTRA];
  const watch = (base.tables.user_watchlist ?? []).map((r) => ({ ...r, item_type: "reg" }));
  const timelines = items.map((i, n) => ({ id: `eeeeeeee-0000-4000-8000-0000000000${String(n + 10)}`, item_id: i.id, milestone_date: "2026-12-01", label: "Application date", is_completed: false, sort_order: 1 }));
  const db = new MemDb({ ids: "uuid" }, { ...Object.fromEntries(Object.entries(base.tables)), intelligence_items: items, user_watchlist: watch, item_timelines: timelines, ...portfolioRows() });
  installWorkspaceReadRpcs(db);
  db.rpcs.is_platform_admin = () => ({ data: false });
  for (const [name, domains] of Object.entries(SURFACE_DOMAINS)) db.rpcs[name] = (a, d) => ({ data: d.rows("intelligence_items").filter((i) => i.provenance_status === "verified" && i.is_archived !== true && domains.includes(Number(i.domain))).map(listRow) });
  db.rpcs.get_research_source_coverage = () => ({ data: [] });
  db.rpcs.load_settings_bundle = () => ({ data: { overrides: [], personal: [], supersessions: [], history: [], truncated: { overrides: false, personal: false, supersessions: false } } });
  void ORG;
  scripted.user = () => memberClient(db);
  scripted.service = null;
  scripted.anon = () => db; // the public reads (the map, the cached lists) are the same rows read without an identity
  return {
    db,
    reads: () => ({ tables: [...new Set(db.reads().map((c) => c.table))], rpcs: [...new Set(db.rpcCalls.map((c) => c.name))] }),
    failTable: (table) => void db.fail(table, "select", "refused by the page sweep"),
    failRpc: (rpc) => void db.rpcFail.set(rpc, { message: "refused by the page sweep" }),
  };
}

/** The member's world with the service client scripted over the same database: the pages that read aggregates on the service client (the coverage matrix) draw over it. */
export function serviceWorld(): SweepWorld & { db: MemDb } {
  const w = memberWorld();
  scripted.service = () => w.db;
  return w;
}

/** The same world with the caller a platform admin and the service client scripted over the same database: the admin console's reads run on the service client behind the admin gate. */
export function adminWorld(): SweepWorld & { db: MemDb } {
  const w = memberWorld();
  w.db.rpcs.is_platform_admin = () => ({ data: true });
  w.db.rpcs.admin_attention_counts = () => ({ data: [{ provisional_sources_pending: 0, staged_updates_pending: 0, staged_updates_materialization_failed: 0, integrity_flags_unresolved: 0, platform_integrity_flags_open: 0, source_attribution_mismatches: 0, auto_approved_awaiting_spotcheck: 0, coverage_gaps_critical: 0, ingest_rejections_untriaged: 0, total: 0 }] });
  w.db.rpcs.get_tier_opinion_disagreements = () => ({ data: [] });
  scripted.service = () => w.db;
  return w;
}
