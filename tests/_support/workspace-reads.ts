// The workspace read functions of the database (get_workspace_due_next, get_workspace_recent_changes, search_intelligence_items, get_surface_counts, get_all_surface_counts,
// get_workspace_intelligence_aggregates, get_source_citation_stats) as stand-ins over the rows a MemDb holds, written from their SQL in supabase/schema.sql: the same gates (verified, not archived after
// the workspace override), the same orders, the same windows. Like installPropagationRpcs, they let a surface slice read what the fixture turn wrote instead of rows it seeded itself. The membership
// assertion (_assert_org_membership) is the database's own and is proven by the schema job; the stand-ins take the org id as given.
import { surfaceOf } from "@/core/routing";

import type { MemDb, Row } from "./memdb.ts";

const RANK: Record<string, number> = { CRITICAL: 1, HIGH: 2, MODERATE: 3, LOW: 4 };
const today = (db: MemDb): string => db.now.slice(0, 10);
const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The org's active items: verified, and not archived once the workspace's override is laid over the platform row. `effective_*` carry the override. */
export function activeItems(db: MemDb, orgId: string): Row[] {
  return db
    .rows("intelligence_items")
    .filter((i) => i.provenance_status === "verified")
    .map((i) => {
      const o = db.rows("workspace_item_overrides").find((x) => x.item_id === i.id && x.org_id === orgId);
      return { ...i, effective_priority: (o?.priority_override as string | null | undefined) ?? i.priority ?? null, effective_archived: (o?.is_archived as boolean | null | undefined) ?? i.is_archived ?? false };
    })
    .filter((i) => !i.effective_archived);
}

export function installWorkspaceReadRpcs(db: MemDb): MemDb {
  // get_workspace_items_by_ids (migration 0095): the named items the workspace holds, the override laid over the row, an item another replaced absent.
  db.rpcs.get_workspace_items_by_ids = (a, d) => ({ data: activeItems(d, String(a.p_org_id)).filter((i) => (a.p_ids as string[]).includes(String(i.id)) && (i.replaced_by ?? null) === null) });
  db.rpcs.get_workspace_due_next = (a, d) => {
    const t = today(d);
    const limit = Math.min(Math.max(Number(a.p_limit ?? 24), 1), 100);
    const dated = activeItems(d, String(a.p_org_id))
      .map((i): Row => {
        const dates = [i.compliance_deadline && String(i.compliance_deadline) >= t ? String(i.compliance_deadline) : null, ...d.rows("item_timelines").filter((x) => x.item_id === i.id && String(x.milestone_date) >= t).map((x) => String(x.milestone_date))].filter((x): x is string => !!x);
        return { ...i, next_binding_date: dates.sort()[0] ?? null };
      })
      .filter((i) => i.next_binding_date !== null)
      .sort((x, y) => String(x.next_binding_date).localeCompare(String(y.next_binding_date)) || String(x.id).localeCompare(String(y.id)));
    return { data: dated.slice(0, limit) };
  };
  db.rpcs.get_workspace_recent_changes = (a, d) => {
    const cutoff = addDays(today(d), -Math.max(Number(a.p_days ?? 7), 1));
    const active = activeItems(d, String(a.org_id ?? a.p_org_id));
    const pick = (i: Row, kind: string, date: unknown) => ({ id: i.id, legacy_id: i.legacy_id ?? null, title: i.title, priority: i.priority ?? null, effective_priority: i.effective_priority, added_date: i.added_date ?? null, change_kind: kind, change_date: date });
    const fresh = active.filter((i) => String(i.added_date ?? "") >= cutoff).map((i) => pick(i, "new", i.added_date));
    const newIds = new Set(fresh.map((x) => x.id));
    const updated = active
      .filter((i) => !newIds.has(i.id))
      .flatMap((i) => {
        const logs = d.rows("item_changelog").filter((c) => c.item_id === i.id && c.change_type === "UPDATED" && String(c.change_date) >= cutoff);
        return logs.length ? [pick(i, "updated", logs.map((c) => String(c.change_date)).sort().pop())] : [];
      });
    const rank = (x: { effective_priority: unknown }) => RANK[String(x.effective_priority)] ?? 5;
    return { data: [...fresh, ...updated].sort((x, y) => rank(x) - rank(y) || String(y.change_date).localeCompare(String(x.change_date)) || String(x.id).localeCompare(String(y.id))).slice(0, 500) };
  };
  db.rpcs.search_intelligence_items = (a, d) => {
    const terms = String(a.q ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const rank = (i: Row) => terms.reduce((n, w) => n + (String(i.title ?? "").toLowerCase().split(w).length - 1) * 4 + (String(i.summary ?? "").toLowerCase().split(w).length - 1) * 2 + (String(i.full_brief ?? "").toLowerCase().split(w).length - 1), 0);
    const hits = d
      .rows("intelligence_items")
      .filter((i) => i.provenance_status === "verified" && !i.is_archived && terms.length > 0 && terms.every((w) => `${i.title} ${i.summary} ${i.full_brief}`.toLowerCase().includes(w)))
      .map((i) => ({ id: i.id, rank: rank(i) }))
      .sort((x, y) => y.rank - x.rank || String(x.id).localeCompare(String(y.id)));
    return { data: hits.slice(0, Math.min(Math.max(Number(a.max_rows ?? 12), 1), 30)) };
  };
  const bySurface = (items: Row[], surface: string) => items.filter((i) => surfaceOf(i.item_type as string | null, i.domain as number | null) === surface);
  db.rpcs.get_surface_counts = (a, d) => {
    const items = bySurface(activeItems(d, String(a.p_org_id)), String(a.p_surface));
    const by = (key: string) => items.reduce<Record<string, number>>((m, i) => ((m[String(i[key] ?? "none")] = (m[String(i[key] ?? "none")] ?? 0) + 1), m), {});
    // the database leaves a NULL severity or band out of its tally
    const tally = (key: string) => items.reduce<Record<string, number>>((m, i) => (i[key] == null ? m : ((m[String(i[key])] = (m[String(i[key])] ?? 0) + 1), m)), {});
    return { data: { total_items: items.length, by_priority: by("effective_priority"), by_severity: tally("severity"), by_band: tally("signal_band"), by_status: by("status"), by_jurisdiction: {}, total_jurisdictions: new Set(items.flatMap((i) => (i.jurisdiction_iso as string[] | undefined) ?? [])).size, last_updated_at: null } };
  };
  db.rpcs.get_all_surface_counts = (a, d) => {
    const scope = d.rows("intelligence_items").filter((i) => {
      const o = d.rows("workspace_item_overrides").find((x) => x.item_id === i.id && x.org_id === a.p_org_id);
      return !((o?.is_archived as boolean | undefined) ?? i.is_archived);
    });
    const out: Record<string, { verified: number; total: number }> = {};
    for (const s of ["regulations", "market", "operations", "research", "uncategorized"]) {
      const mine = bySurface(scope, s);
      out[s] = { verified: mine.filter((i) => i.provenance_status === "verified").length, total: mine.length };
    }
    out.total = { verified: Object.values(out).reduce((n, x) => n + x.verified, 0), total: Object.values(out).reduce((n, x) => n + x.total, 0) };
    return { data: out };
  };
  db.rpcs.get_workspace_intelligence_aggregates = (a, d) => {
    const items = activeItems(d, String(a.p_org_id));
    const by_priority: Record<string, number> = {};
    for (const i of items) by_priority[String(i.effective_priority)] = (by_priority[String(i.effective_priority)] ?? 0) + 1;
    return { data: { total_items: items.length, by_priority, by_status: {}, by_jurisdiction: {}, total_jurisdictions: new Set(items.flatMap((i) => (i.jurisdiction_iso as string[] | undefined) ?? [])).size, last_updated_at: null } };
  };
  db.rpcs.get_source_citation_stats = (a, d) => ({
    data: ((a.source_ids as string[]) ?? []).map((id) => {
      const mine = d.rows("intelligence_items").filter((i) => i.source_id === id);
      return { source_id: id, citation_count: mine.length, recency: mine.map((i) => String(i.added_date ?? "")).sort().pop() ?? null };
    }),
  });
  return db;
}
