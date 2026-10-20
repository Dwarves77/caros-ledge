// Ported from old_repo/src/lib/supabase-server.ts (lines 4236-4423)
// The cross-page reads: the stated intersection summary, the theme analysis (members by page, the brief, the lineage of a dissolved theme), the inferences a customer may read, and the theme
// chips of a list page. Every read is on the caller's client (RLS) and bounded; a failed block is NAMED in `degraded` so the page says it did not load, never an absent section (INV-263).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { buildIntersectionView, lineageFromThemeDelta, type ConnectionIn, type ResourceLookup } from "@/core/flywheel";
import { themeAnalysisView, themeChips, themeForItem, type BriefRow, type MemberRow, type ThemeAnalysisView, type ThemeRow } from "@/core/themes";

import { readCustomerInferences, type InferenceView } from "./inference-view";

const THEME_COLUMNS = "id, member_ids, dominant_signals, density, convergence, surfaces, pivots";
const BRIEF_COLUMNS = "theme_id, title, brief_md, member_hash, generated_at, sections, member_ids";
const CAP = 5000;

export interface CrossPage {
  intersections: ReturnType<typeof buildIntersectionView>;
  intersectionSummary: string | null;
  theme: ThemeAnalysisView | null;
  inferences: InferenceView | null;
  /** The blocks whose read failed this request ("themes", "inferences"): the page offers Retry and does not call them empty. */
  degraded: string[];
}

const readThemes = (db: Db): Promise<ThemeRow[]> => fetchAllRows<ThemeRow>((from, to) => db.from("connection_themes").select(THEME_COLUMNS).order("id", { ascending: true }).range(from, to) as never, { cap: CAP });
const readBriefs = (db: Db): Promise<BriefRow[]> => fetchAllRows<BriefRow>((from, to) => db.from("theme_briefs").select(BRIEF_COLUMNS).order("theme_id", { ascending: true }).range(from, to) as never, { cap: CAP });

async function readLineage(db: Db) {
  const { data, error } = await db.from("connection_theme_runs").select("theme_delta").eq("status", "ok").order("started_at", { ascending: false }).limit(1);
  if (error) throw new Error(`connection_theme_runs read failed: ${error.message}`);
  return data?.length ? lineageFromThemeDelta((data[0] as { theme_delta: never }).theme_delta) : [];
}

/** Verified, non-archived items by uuid (the readers' own RLS applies on top). */
const readVerifiedItemsByIds = (db: Db, ids: readonly string[]): Promise<MemberRow[]> =>
  fetchAllByIdChunks(
    ids,
    async (slice) => {
      const r = await db.from("intelligence_items").select("id, legacy_id, title, item_type, domain").eq("is_archived", false).eq("provenance_status", "verified").in("id", slice);
      if (r.error) throw new Error(`intelligence_items read failed: ${r.error.message}`);
      return (r.data ?? []) as MemberRow[];
    },
    { chunk: 100, manyPerId: true },
  );

/** The theme block of one item: null when the item belongs to no theme. Throws on a failed read. */
async function readTheme(db: Db, itemUuid: string, surface: string): Promise<ThemeAnalysisView | null> {
  const themes = await readThemes(db);
  const theme = themeForItem(themes, itemUuid);
  if (!theme) return null;
  const [briefs, lineage, members] = await Promise.all([readBriefs(db), readLineage(db), readVerifiedItemsByIds(db, theme.member_ids)]);
  return themeAnalysisView({ itemId: itemUuid, surface, themes, briefs, lineage, members });
}

/** The inferences a customer may read for an item, per request. */
const readFreshInferences = (db: Db, itemUuid: string): Promise<InferenceView | null> => readCustomerInferences(db, itemUuid);

/** The cross-page analysis of one item: each block read on its own, so one failing block does not take the others down. */
export async function readCrossPage(db: Db, itemUuid: string, surface: string, intersectionSummary: string | null, connections: readonly ConnectionIn[], lookup: ResourceLookup): Promise<CrossPage> {
  const degraded: string[] = [];
  const [theme, inferences] = await Promise.all([
    readTheme(db, itemUuid, surface).catch(() => (degraded.push("themes"), null)),
    readFreshInferences(db, itemUuid).catch(() => (degraded.push("inferences"), null)),
  ]);
  return { intersections: buildIntersectionView(connections, lookup, { currentSurface: surface, summary: intersectionSummary }), intersectionSummary, theme, inferences, degraded };
}

/** The theme chips of a list page (`surface` null is the cross-page view the dashboard reads). Throws on a failed read; the caller says the strip did not load. */
export async function readThemeChips(db: Db, opts: { surface: string | null; minPages?: number; max?: number }) {
  const themes = (await readThemes(db)).filter((t) => (opts.surface ? (t.surfaces ?? []).includes(opts.surface) : (t.surfaces ?? []).length >= (opts.minPages ?? 1))).sort((a, b) => (b.convergence ?? 0) - (a.convergence ?? 0)).slice(0, 12);
  if (themes.length === 0) return [];
  const [briefs, lineage, items] = await Promise.all([readBriefs(db), readLineage(db), readVerifiedItemsByIds(db, themes.flatMap((t) => t.member_ids ?? []))]);
  return themeChips({ themes, items, briefs, lineage, surface: opts.surface, minPages: opts.minPages ?? 1, max: opts.max ?? 6 });
}
