// Ported from old_repo/src/lib/supabase-server.ts (lines 1749-1793)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2264-2266)
// Ported from old_repo/src/app/research/page.tsx (lines 34-61)
// Ported from old_repo/src/app/research/[slug]/page.tsx (lines 114-263)
// Ported from old_repo/src/lib/research/read-signposts.mjs (lines 68-77)
// Ported from old_repo/src/lib/research/read-signposts.mjs (lines 120-144)
// The Research readers, on the query kit (tables read: research_assessments_current, research_assessment_history, signposts, entities, intelligence_items; the list itself is the shared list read in features/lists).
// A failed read is a failed state beside what did load, never an empty list and never "none yet" (INV-263): the old readers dropped every error and read an outage as "no assessment".
import { fetchAllByIdChunks, type Db } from "@/core/db";
import { log } from "@/core/shared/log";
import type { Resource } from "@/core/types";
import { readCategory, readSurfaceCounts, type WorkspaceAggregates } from "@/features/lists";

import { ASSESSMENT_COLUMNS, selectAssessmentView, selectAssessmentViewsByItemId, selectHistoryEntry, selectSignpostView, SIGNPOST_COLUMNS, type AssessmentRow, type AssessmentView, type HistoryEntry, type SignpostRow, type SignpostView } from "../model/assessment-view";

const MAX_CHAIN = 25;
const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const warn = (what: string, e: unknown): void => log.warn(`[research-reads] ${what} failed:`, e instanceof Error ? e.message : String(e));

export interface ResearchCoverageCell {
  transportMode: string;
  jurisdictionIso: string;
  sourceCount: number;
}
export interface ResearchPageData {
  rows: Resource[];
  rowsFailed: boolean;
  aggregates: WorkspaceAggregates | null;
  /** Null when the coverage read failed (the rail says so); an empty list is an honest empty matrix. */
  coverage: ResearchCoverageCell[] | null;
  /** The current assessment per item, keyed by the item's list id; null when the batch read failed. */
  assessments: Record<string, AssessmentView> | null;
}

/** The uuid behind each list id (a legacy id is looked up); an id with no row has no entry. */
async function uuidsOf(db: Db, listIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map(listIds.filter(isUuid).map((id) => [id, id]));
  const legacy = listIds.filter((id) => !isUuid(id));
  const rows = await fetchAllByIdChunks(legacy, async (slice) => {
    const { data, error } = await db.from("intelligence_items").select("id, legacy_id").in("legacy_id", slice);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; legacy_id: string }>;
  });
  for (const r of rows) out.set(r.legacy_id, r.id);
  return out;
}

/** The batched current assessments for the rows a page shows: one chunked read of the view, keyed by list id. */
export async function readAssessmentsFor(db: Db, listIds: readonly string[]): Promise<Record<string, AssessmentView>> {
  const uuid = await uuidsOf(db, listIds);
  const rows = await fetchAllByIdChunks([...uuid.values()], async (slice) => {
    const { data, error } = await db.from("research_assessments_current").select(ASSESSMENT_COLUMNS).in("item_id", slice);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as AssessmentRow[];
  });
  const byUuid = selectAssessmentViewsByItemId(rows);
  const out: Record<string, AssessmentView> = {};
  for (const [listId, id] of uuid) {
    const v = byUuid.get(id);
    if (v) out[listId] = v;
  }
  return out;
}

async function readCoverage(db: Db): Promise<ResearchCoverageCell[]> {
  const { data, error } = await db.rpc("get_research_source_coverage");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ transport_mode: unknown; jurisdiction_iso: unknown; source_count: unknown }>)
    // A cell whose count is not a number is dropped, never drawn as a zero (register surfaces:86).
    .filter((r) => typeof r.transport_mode === "string" && typeof r.jurisdiction_iso === "string" && typeof r.source_count === "number" && Number.isFinite(r.source_count))
    .map((r) => ({ transportMode: r.transport_mode as string, jurisdictionIso: r.jurisdiction_iso as string, sourceCount: r.source_count as number }));
}

const settle = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (e) {
    warn(what, e);
    return null;
  }
};

/** Everything /research draws: the category-routed public items, the corpus tallies, the source coverage and the batched assessments, each with its own failed state. */
/** `orgId` is the member's org: get_surface_counts refuses a null org to every caller but the service role (migration 361), and the Region facet is offered from its surface-wide tally. */
export async function readResearchPage(db: Db, orgId: string | null): Promise<ResearchPageData> {
  const [category, aggregates, coverage] = await Promise.all([readCategory(db, "get_research_items_public"), readSurfaceCounts(db, orgId, "research"), settle("source coverage", () => readCoverage(db))]);
  const assessments = category.failed ? null : await settle("assessments", () => readAssessmentsFor(db, category.resources.map((r) => r.id)));
  return { rows: category.resources, rowsFailed: category.failed, aggregates, coverage, assessments };
}

export interface AssessmentBundle {
  assessment: AssessmentView | null;
  signposts: SignpostView[];
  /** Newest first; the current assessment is the first entry. */
  history: HistoryEntry[];
  /** False when an earlier assessment the chain points at could not be read, so the chain shown is shorter than the real one. */
  historyComplete: boolean;
  failed: boolean;
}
const NO_BUNDLE: AssessmentBundle = { assessment: null, signposts: [], history: [], historyComplete: true, failed: true };

/**
 * An item's current assessment, the signposts watching it (with the watched entity's name) and the append-only chain of the assessments it superseded. The chain is walked through research_assessment_history
 * (migration 0040) on the caller's own client; a link that cannot be read (absent view, an unreadable row) makes `historyComplete` false and the page says the chain is shorter than the real one.
 */
export async function readAssessmentBundle(db: Db, itemUuid: string): Promise<AssessmentBundle> {
  try {
    const cur = await db.from("research_assessments_current").select(ASSESSMENT_COLUMNS).eq("item_id", itemUuid).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    const assessment = selectAssessmentView(cur.data as unknown as AssessmentRow | null);
    if (!assessment) return { assessment: null, signposts: [], history: [], historyComplete: true, failed: false };
    const sp = await db.from("signposts").select(SIGNPOST_COLUMNS).eq("assessment_id", assessment.id);
    if (sp.error) throw new Error(sp.error.message);
    const posts = (sp.data ?? []) as unknown as SignpostRow[];
    const names = new Map<string, string>();
    if (posts.length) {
      const ents = await db.from("entities").select("entity_id, canonical_name, display_name").in("entity_id", [...new Set(posts.map((p) => p.watches))]);
      if (ents.error) throw new Error(ents.error.message);
      for (const e of (ents.data ?? []) as Array<{ entity_id: string; canonical_name: string | null; display_name: string | null }>) if (e.display_name || e.canonical_name) names.set(e.entity_id, (e.display_name || e.canonical_name) as string);
    }
    const signposts = posts.map((p) => selectSignpostView(p, (id) => names.get(id) ?? null)).sort((a, b) => Number(a.firedAt !== null) - Number(b.firedAt !== null));
    const history = [selectHistoryEntry(assessment, true)];
    let next = assessment.supersedes;
    let historyComplete = true;
    for (let depth = 0; next && depth < MAX_CHAIN; depth += 1) {
      const prior = await db.from("research_assessment_history").select(ASSESSMENT_COLUMNS).eq("id", next).maybeSingle();
      if (prior.error) {
        warn("assessment history", prior.error);
        break;
      }
      const v = selectAssessmentView(prior.data as unknown as AssessmentRow | null);
      if (!v) {
        historyComplete = false;
        break;
      }
      history.push(selectHistoryEntry(v, false));
      next = v.supersedes;
    }
    if (next) historyComplete = false;
    return { assessment, signposts, history, historyComplete, failed: false };
  } catch (e) {
    warn("assessment bundle", e);
    return NO_BUNDLE;
  }
}
