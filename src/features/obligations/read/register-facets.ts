// Ported from old_repo/src/lib/obligations/read-register.mjs (lines 173-186)
// Ported from old_repo/src/lib/obligations/read-register.mjs (lines 491-611)
// The register's facets: the jurisdictions and modes in the data with live counts (corpus-wide, independent of the loaded page), the binding-position and
// due-window tallies, and the honest-empty forward-event count ("not yet derived from N forward events", never "nothing"). A failed read throws: the old
// reader answered an empty facet set, which hid the failure.
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { fetchAllRows, qb } from "@/core/db";
import { notInList, suppressedEventIds } from "@/core/derived/suppressed-events";

export const UNCLASSIFIED_KEY = "unclassified";
const WINDOWS = ["overdue", "30", "90", "365", "undated", "all"] as const;

export interface RegisterFacets {
  jurisdictions: string[];
  modes: string[];
  counts: { jurisdiction: Record<string, number>; mode: Record<string, number>; bindingPosition: Record<string, number>; dueWindow: Record<string, number> };
}
export const emptyRegisterFacets = (): RegisterFacets => ({ jurisdictions: [], modes: [], counts: { jurisdiction: {}, mode: {}, bindingPosition: {}, dueWindow: {} } });

/** Whether a due date falls in a window ("overdue", the next 30/90/365 days, "undated", "all"); a dated window never matches an undated row. */
export function matchesDueWindow(dueDate: string | null | undefined, dueWindow: string, todayIso: string): boolean {
  if (dueWindow === "all") return true;
  if (dueWindow === "undated") return dueDate === null || dueDate === undefined;
  if (dueDate === null || dueDate === undefined) return false;
  if (dueWindow === "overdue") return dueDate < todayIso;
  const days = Number(dueWindow);
  if (!Number.isFinite(days)) return true;
  const from = new Date(`${todayIso}T00:00:00Z`);
  const d = new Date(`${dueDate}T00:00:00Z`);
  return d >= from && d <= new Date(from.getTime() + days * 86_400_000);
}

export function tallyRegisterFacets(rows: readonly { jurisdiction?: string[] | null; modes?: string[] | null; binding_position?: string | null; due_date?: string | null }[], todayIso: string): RegisterFacets {
  const out = emptyRegisterFacets();
  const jurisdictions = new Set<string>();
  const modes = new Set<string>();
  const bump = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
  };
  for (const row of rows) {
    for (const j of new Set(row.jurisdiction ?? [])) {
      jurisdictions.add(j);
      bump(out.counts.jurisdiction, j);
    }
    for (const m of new Set(row.modes ?? [])) {
      modes.add(m);
      bump(out.counts.mode, m);
    }
    bump(out.counts.bindingPosition, row.binding_position ?? UNCLASSIFIED_KEY);
    for (const w of WINDOWS) if (w !== "all" && matchesDueWindow(row.due_date ?? null, w, todayIso)) bump(out.counts.dueWindow, w);
  }
  out.jurisdictions = [...jurisdictions].sort();
  out.modes = [...modes].sort();
  return out;
}

/** Facets over the active obligations of admissible items, minus the events of a suppressed claim (the same join and filters the register applies). A failed page throws. */
export async function fetchRegisterFacetOptions(sb: Db, todayIso: string): Promise<RegisterFacets> {
  const suppressed = notInList(await suppressedEventIds(sb));
  const rows = await fetchAllRows<{ jurisdiction: string[] | null; modes: string[] | null; binding_position: string | null; due_date: string | null; id: string }>(
    (from, to) => {
      const q = admitItems(qb(sb.from("obligations").select("id, jurisdiction, modes, binding_position, due_date, item:intelligence_items!inner(id)")).eq("status", "active"), "item");
      return (suppressed ? q.not("forward_event_id", "in", suppressed) : q).order("id").range(from, to) as unknown as PromiseLike<{ data: never[] | null; error: { message: string } | null }>;
    },
    { cap: 500_000 },
  );
  return tallyRegisterFacets(rows, todayIso);
}

/** The forward events a reader can see (the honest-empty count): those of an admissible item, minus a suppressed claim's. A failed count throws. */
export async function fetchForwardEventCount(sb: Db): Promise<number> {
  const suppressed = notInList(await suppressedEventIds(sb));
  const q = admitItems(qb(sb.from("item_forward_events").select("id, item:intelligence_items!inner(id)", { count: "exact", head: true })), "item");
  const { count, error } = await (suppressed ? q.not("id", "in", suppressed) : q);
  if (error) throw new Error(`item_forward_events count failed: ${error.message}`);
  if (typeof count !== "number") throw new Error("item_forward_events count failed: no count returned");
  return count;
}
