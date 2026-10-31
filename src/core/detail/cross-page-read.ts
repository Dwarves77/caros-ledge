// Ported from old_repo/src/lib/supabase-server.ts (lines 4236-4423)
// The cross-page reads: the stated intersection summary, the theme analysis (members by page, the brief), the inferences a customer may read, and the theme
// chips of a list page. Every read is on the caller's client (RLS) and bounded; a failed block is NAMED in `degraded` so the page says it did not load, never an absent section (INV-263).
import { admitItems } from "@/core/derived/admissible";
import { notInList, suppressedEventIds } from "@/core/derived/suppressed-events";
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { surfaceHref, surfaceOf } from "@/core/routing";
import { log } from "@/core/shared/log";
import { buildIntersectionView, type ConnectionIn, type ResourceLookup } from "@/core/flywheel";
import { type ItemExtras, readItemExtras, readLinkedBy } from "@/features/flywheel/radar/read";
import { compareThemes, HORIZONS, inThemeScope, themeAnalysisView, themeChips, themeForItem, type BriefRow, type MemberRow, type ThemeAnalysisView, type ThemeEventRow, type ThemeRow } from "@/core/themes";

import { readCustomerInferences, type InferenceView } from "./inference-view";

const THEME_COLUMNS = "id, member_ids, dominant_signals, density, convergence, surfaces, pivots";
const BRIEF_COLUMNS = "theme_id, title, brief_md, member_hash, generated_at, superseded_at, sections, member_ids";
const CAP = 5000;

export interface CrossPage extends ItemExtras {
  intersections: ReturnType<typeof buildIntersectionView>;
  theme: ThemeAnalysisView | null;
  inferences: InferenceView | null;
  /** The blocks whose read failed this request ("themes", "inferences"): the page offers Retry and does not call them empty. */
  degraded: string[];
}

const readThemes = (db: Db): Promise<ThemeRow[]> => fetchAllRows<ThemeRow>((from, to) => db.from("connection_themes").select(THEME_COLUMNS).order("id", { ascending: true }).range(from, to) as never, { cap: CAP });
const readBriefs = (db: Db): Promise<BriefRow[]> => fetchAllRows<BriefRow>((from, to) => db.from("theme_briefs").select(BRIEF_COLUMNS).order("theme_id", { ascending: true }).range(from, to) as never, { cap: CAP });

/** Admissible items by uuid: verified, not archived, not replaced (the readers' own RLS applies on top). */
const readVerifiedItemsByIds = (db: Db, ids: readonly string[]): Promise<MemberRow[]> =>
  fetchAllByIdChunks(
    ids,
    async (slice) => {
      const r = await admitItems(db.from("intelligence_items").select("id, legacy_id, title, item_type, domain, compliance_deadline")).in("id", slice);
      if (r.error) throw new Error(`intelligence_items read failed: ${r.error.message}`);
      return (r.data ?? []) as MemberRow[];
    },
    { chunk: 100, manyPerId: true },
  );

/** The dated forward events of the theme's members from `fromIso` on (a suppressed claim's events and the kinds the customer reads leave out are not read). Throws on a failed read. */
async function readMemberEvents(db: Db, ids: readonly string[], fromIso: string): Promise<ThemeEventRow[]> {
  const suppressed = notInList(await suppressedEventIds(db));
  return fetchAllByIdChunks<ThemeEventRow>(
    ids,
    async (slice) => {
      let q = db.from("item_forward_events").select("id, intelligence_item_id, event_date, date_precision, event_kind").gte("event_date", fromIso).in("intelligence_item_id", slice).not("event_kind", "in", `(${HORIZONS.excludedEventKinds.join(",")})`);
      if (suppressed) q = q.not("id", "in", suppressed);
      const r = await q;
      if (r.error) throw new Error(`item_forward_events read failed: ${r.error.message}`);
      return (r.data ?? []) as ThemeEventRow[];
    },
    { chunk: 100, manyPerId: true },
  );
}

/** The theme block of one item: null when the item belongs to no theme. Throws on a failed read. */
async function readTheme(db: Db, itemUuid: string, surface: string, asOfIso: string): Promise<ThemeAnalysisView | null> {
  const themes = await readThemes(db);
  const theme = themeForItem(themes, itemUuid);
  if (!theme) return null;
  const [briefs, members, events] = await Promise.all([readBriefs(db), readVerifiedItemsByIds(db, theme.member_ids), readMemberEvents(db, theme.member_ids, asOfIso.slice(0, 10))]);
  const input = { itemId: itemUuid, surface, themes, briefs, members, events, asOfIso };
  const view = themeAnalysisView(input);
  // a theme with no usable brief says what its edges are mostly about (their entities and scenarios); the edges are read only then
  return view?.cluster ? themeAnalysisView({ ...input, linkedBy: await readLinkedBy(db, theme.member_ids) }) : view;
}

const BRACKET_ID = /\s*\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
/** A stated summary with its bracketed item ids read as links to the items' titles; an id no admissible item holds (or that cannot be read) is dropped from the text shown. The stored summary is untouched. */
async function resolveBracketedIds(db: Db, text: string | null): Promise<string | null> {
  const ids = [...new Set([...(text ?? "").matchAll(BRACKET_ID)].map((m) => (m[1] as string).toLowerCase()))];
  if (!text || ids.length === 0) return text;
  const link = new Map<string, string>();
  try {
    for (const r of await readVerifiedItemsByIds(db, ids)) {
      const href = surfaceHref(surfaceOf(r.item_type, r.domain), r.legacy_id || r.id);
      if (href && r.title) link.set(r.id, ` [${r.title.replace(/[[\]]/g, "")}](${href})`);
    }
  } catch (e) {
    log.warn("[cross-page] summary ids did not resolve:", e instanceof Error ? e.message : String(e));
  }
  return text.replace(BRACKET_ID, (_m, id: string) => link.get(id.toLowerCase()) ?? "").trim();
}

/** The cross-page analysis of one item: each block read on its own, so one failing block does not take the others down. `facts` are the item's own structured rows (the join of its entities). */
export async function readCrossPage(db: Db, itemUuid: string, surface: string, intersectionSummary: string | null, connections: readonly ConnectionIn[], lookup: ResourceLookup | Promise<ResourceLookup>, asOfIso: string, facts: Parameters<typeof readItemExtras>[3] = []): Promise<CrossPage> {
  const degraded: string[] = [];
  const [theme, inferences, summary] = await Promise.all([
    readTheme(db, itemUuid, surface, asOfIso).catch(() => (degraded.push("themes"), null)),
    readCustomerInferences(db, itemUuid).catch(() => (degraded.push("inferences"), null)),
    resolveBracketedIds(db, intersectionSummary),
  ]);
  return { intersections: buildIntersectionView(connections, await lookup, { currentSurface: surface, summary }), theme, ...(await readItemExtras(db, itemUuid, theme?.memberIds ?? [], facts)), inferences, degraded };
}

/** The theme chips of a list page (`surface` null is the cross-page view the dashboard reads). Throws on a failed read; the caller says the strip did not load. */
export async function readThemeChips(db: Db, opts: { surface: string | null; minPages?: number; max?: number }) {
  const [all, briefs] = await Promise.all([readThemes(db), readBriefs(db)]);
  const key = (t: ThemeRow) => ({ hasBrief: briefs.some((b) => b.theme_id === t.id), surfaces: (t.surfaces ?? []).length, members: (t.member_ids ?? []).length, convergence: t.convergence ?? 0, id: t.id });
  // the same scope and order themeChips applies, so the 25 read are the 25 it can show
  const themes = all.filter((t) => inThemeScope(key(t).members, key(t).surfaces) && (opts.surface ? (t.surfaces ?? []).includes(opts.surface) : key(t).surfaces >= (opts.minPages ?? 1))).sort((a, b) => compareThemes(key(a), key(b))).slice(0, 25);
  if (themes.length === 0) return [];
  const items = await readVerifiedItemsByIds(db, themes.flatMap((t) => t.member_ids ?? []));
  return themeChips({ themes, items, briefs, surface: opts.surface, minPages: opts.minPages ?? 1, max: opts.max ?? 6 });
}
