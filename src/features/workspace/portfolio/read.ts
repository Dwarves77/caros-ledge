// Ported from old_repo/src/lib/portfolio/read.ts (lines 1-172)
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db/clients";
import { fetchAllByIdChunks } from "@/core/db/query";
import { LookupError } from "@/core/http/errors";

import { computeRollup, getPortfolio, listMembers } from "./core";
import { SURFACE_KEYS, type HeldRow, type PortfolioDeps, type PortfolioDetailView, type PortfolioEntityRow, type PortfolioItemRow } from "./types";

/** The held-items read layer bounds each call at 40 ids. */
const HELD_CHUNK = 40;
const LOOKUP_CHUNK = 100;

interface EntityRow {
  entity_id: string;
  kind: string;
  canonical_name: string;
  display_name: string | null;
}
interface KeyRow {
  id: string;
  legacy_id: string | null;
  origin_class: string | null;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const entityLabel = (e: EntityRow, deps: PortfolioDeps): string => e.display_name || (e.kind === "corridor" ? deps.corridorLabel(e.canonical_name) : null) || e.canonical_name;

/**
 * One portfolio, its members hydrated, grouped by surface, with the roll-ups. null when it is not in this org. Held means the
 * same bounded read the dashboard cards use; anything it does not return stays a member, counted in the denominator and named in
 * `notHeld`, and is left out of every figure. A failed read throws LookupError.
 */
export async function readPortfolioDetail(client: Db, orgId: string, portfolioId: string, now: Date, deps: PortfolioDeps): Promise<PortfolioDetailView | null> {
  const portfolio = await getPortfolio(client, orgId, portfolioId);
  if (!portfolio) return null;
  const rows = await listMembers(client, { orgId, portfolioId });
  const members = rows.map((m) => ({ kind: m.member_kind, itemId: m.item_id, entityId: m.entity_id }));
  const itemIds = members.filter((m) => m.kind === "item").map((m) => m.itemId as string);
  const entityIds = members.filter((m) => m.kind !== "item").map((m) => m.entityId as string);

  const held: HeldRow[] = [];
  for (const ids of chunks(itemIds, HELD_CHUNK)) held.push(...(await deps.heldItems(orgId, ids, now)));
  // The uuid and origin class of the held rows: the held read carries the UI id (legacy id or uuid) only.
  const keyRows = await fetchAllByIdChunks(
    itemIds,
    async (slice) => {
      const { data, error } = await admitItems(client.from("intelligence_items").select("id, legacy_id, origin_class").in("id", slice));
      if (error) throw new LookupError("intelligence_items", error);
      return (data ?? []) as KeyRow[];
    },
    { chunk: LOOKUP_CHUNK },
  );
  const keyByUiId = new Map(keyRows.map((r) => [r.legacy_id || r.id, r]));
  const heldItems: PortfolioItemRow[] = [];
  for (const h of held) {
    const key = keyByUiId.get(h.uiId);
    if (key) heldItems.push({ ...h, itemUuid: key.id, originClass: key.origin_class ?? null });
  }

  const entityRows = await fetchAllByIdChunks(
    entityIds,
    async (slice) => {
      const { data, error } = await client.from("entities").select("entity_id, kind, canonical_name, display_name").in("entity_id", slice);
      if (error) throw new LookupError("entities", error);
      return (data ?? []) as EntityRow[];
    },
    { chunk: LOOKUP_CHUNK },
  );
  const entityById = new Map(entityRows.map((e) => [e.entity_id, e]));
  const entityViews: PortfolioEntityRow[] = [];
  for (const m of members) {
    if (m.kind === "item" || !m.entityId) continue;
    const e = entityById.get(m.entityId);
    if (e) entityViews.push({ entityId: e.entity_id, kind: m.kind === "corridor" ? "corridor" : "entity", entityKind: e.kind, label: entityLabel(e, deps) });
  }

  const rollup = computeRollup({ members, heldItems: heldItems.map((h) => ({ id: h.itemUuid, surface: h.surface, priority: h.priority || null, dueDays: h.dueDays, originClass: h.originClass })) }, deps.weakestOriginClass);
  const groups = SURFACE_KEYS.map((surface) => ({
    surface,
    // Most urgent binding date first; items with no date after, in title order (stable, no invented rank).
    rows: heldItems.filter((h) => h.surface === surface).sort((a, b) => (a.dueDays ?? Infinity) - (b.dueDays ?? Infinity) || a.title.localeCompare(b.title)),
  })).filter((g) => g.rows.length > 0);
  return { portfolio, rollup, groups, entityRows: entityViews, entitiesUnread: entityIds.length - entityViews.length, timelinesFailed: held.some((h) => h.timelineFailed) };
}
