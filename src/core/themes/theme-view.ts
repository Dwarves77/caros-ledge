// Ported from old_repo/src/lib/research/theme-brief.mjs (lines 1-303)
// The cross-page theme view (research-ops.md): which theme an item belongs to, the brief that explains it (current or stale, by member hash and lineage), the analysis a detail page
// draws (members grouped by page, the sections of the brief, what is missing said in words) and the chips a list page draws. Pure: the rows come in already read. The detail page is
// the first consumer; the dashboard and the shell read the same views later.
import { SURFACE_HEADING, parseRamifications } from "@/core/briefs/theme-brief-contract";
import { resolveBriefForTheme } from "@/core/flywheel";
import { SURFACE_LABELS, SURFACE_ORDER, surfaceOf } from "@/core/routing";

import { deriveThemeForwardOutlook, type ThemeEventRow } from "./forward-outlook";

export interface ThemeRow {
  id: string;
  member_ids: string[];
  dominant_signals?: Array<{ signal?: string; weight?: number }> | null;
  density?: number | null;
  convergence?: number | null;
  surfaces?: string[] | null;
  pivots?: Array<{ id?: string }> | null;
}
export interface BriefRow {
  theme_id: string;
  title: string | null;
  brief_md: string | null;
  member_hash?: string | null;
  generated_at?: string | null;
  sections?: Record<string, unknown> | null;
  member_ids?: string[] | null;
  [k: string]: unknown;
}
export interface MemberRow {
  id: string;
  legacy_id: string | null;
  title: string;
  item_type: string | null;
  domain: number | null;
  horizon?: string | null;
  horizon_band?: string | null;
  compliance_deadline?: string | null;
}

type Lineage = { prior_id: string; new_id: string }[];

const MAX_MEMBERS_PER_PAGE = 6;
const MAX_CHIP_MEMBER_LINKS = 3;
const MAX_THEME_LABEL_CHARS = 56;
const trim = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const label = (s: string): string | undefined => SURFACE_LABELS[s];

export const themeForItem = (themes: readonly ThemeRow[] | null | undefined, itemId: string | null | undefined): ThemeRow | null => (itemId && themes ? (themes.find((t) => t && Array.isArray(t.member_ids) && t.member_ids.includes(itemId)) ?? null) : null);

/** A brief explains a theme while its member hash still matches, or while at least half of the members it was written about are still in the theme; a brief that fails both describes a different group and is not shown under this one. */
function briefHolds(theme: ThemeRow, brief: BriefRow | null, stale: boolean): brief is BriefRow {
  const was = brief?.member_ids ?? [];
  return !!brief && (!stale || (was.length > 0 && was.filter((id) => theme.member_ids.includes(id)).length / was.length >= 0.5));
}

/** The brief that explains the item's theme: exact, or inherited from a dissolved theme (always stale), and only while it still describes the theme (briefHolds). */
function briefForItem(itemId: string, themes: readonly ThemeRow[], briefs: readonly BriefRow[], lineage: Lineage) {
  const theme = themeForItem(themes, itemId);
  if (!theme) return null;
  const resolved = resolveBriefForTheme(theme, briefs, { liveThemeIds: new Set(themes.map((t) => t.id)), lineage });
  const b = resolved.brief as BriefRow | null;
  return briefHolds(theme, b, resolved.stale) ? { title: b.title, briefMd: b.brief_md, generatedAt: b.generated_at ?? null, stale: resolved.stale, supersedesThemeId: resolved.supersedes_theme_id, sections: b.sections && typeof b.sections === "object" && !Array.isArray(b.sections) ? b.sections : null } : null;
}

/** What a theme with no usable brief is made of, as data: the member and pivot ids, the surface keys it spans, the words it is mostly linked by (the canonical names and scenarios of its edges) and the counts. The page words it (ADR-050). */
export interface ClusterSummary {
  memberIds: string[];
  pivotIds: string[];
  surfaces: string[];
  linkedBy: string[];
  memberCount: number;
  surfaceCount: number;
  density: number | null;
}
const clusterOf = (theme: ThemeRow, pages: ReadonlyArray<{ surface: string }>, linkedBy: readonly string[]): ClusterSummary => ({
  memberIds: theme.member_ids,
  pivotIds: (theme.pivots ?? []).map((p) => p?.id).filter((id): id is string => typeof id === "string"),
  surfaces: pages.map((p) => p.surface),
  linkedBy: [...linkedBy],
  memberCount: theme.member_ids.length,
  surfaceCount: pages.length,
  density: typeof theme.density === "number" ? theme.density : null,
});

/** The theme analysis of one item on one surface: members by page (other pages first), the brief's sections, and the cluster's structure when there is no brief. */
export function themeAnalysisView(input: { itemId: string; surface: string; themes: readonly ThemeRow[]; briefs: readonly BriefRow[]; lineage?: Lineage; members?: readonly MemberRow[]; events?: readonly ThemeEventRow[]; linkedBy?: readonly string[]; asOfIso: string }) {
  const { itemId, surface, themes, briefs, lineage = [], members = [], events = [], linkedBy = [], asOfIso } = input;
  const theme = themeForItem(themes, itemId);
  if (!theme) return null;
  const brief = briefForItem(itemId, themes, briefs, lineage);
  const pivotRank = new Map((theme.pivots ?? []).map((p, i) => [p?.id, i]));
  const rows: Array<{ id: string; title: string; href: string; surface: string }> = [];
  for (const m of members) {
    if (!m || m.id === itemId || !theme.member_ids.includes(m.id)) continue;
    const s = surfaceOf(m.item_type, m.domain);
    if (!label(s) || !trim(m.title)) continue;
    rows.push({ id: m.id, title: m.title.trim(), href: `/${s}/${encodeURIComponent(m.legacy_id || m.id)}`, surface: s });
  }
  const own = label(surface) ? surface : null;
  const spanned = new Set(rows.map((r) => r.surface));
  if (own) spanned.add(own);
  const pages = SURFACE_ORDER.filter((s) => spanned.has(s)).map((s) => ({ surface: s, label: label(s) as string }));
  const membersByPage = [...SURFACE_ORDER.filter((s) => s !== own), ...SURFACE_ORDER.filter((s) => s === own)]
    .filter((s) => rows.some((r) => r.surface === s))
    .map((s) => {
      const all = rows.filter((r) => r.surface === s).sort((a, b) => (pivotRank.get(a.id) ?? 1e9) - (pivotRank.get(b.id) ?? 1e9) || a.title.localeCompare(b.title));
      return { surface: s, label: label(s) as string, samePage: s === own, total: all.length, items: all.slice(0, MAX_MEMBERS_PER_PAGE).map(({ id, title, href }) => ({ id, title, href })), moreHref: all.length > MAX_MEMBERS_PER_PAGE ? `/${s}` : null };
    });
  let sections: { connection: string | null; meaning: string | null; forThisPage: string | null; watch: string | null; gaps: string | null } | null = null;
  let ramificationsMissing = false;
  if (brief?.sections) {
    const subs = parseRamifications(String(brief.sections.ramifications ?? "")).subs;
    const mine = own ? trim(subs.get(SURFACE_HEADING[own] ?? "")) : null;
    ramificationsMissing = !mine;
    sections = { connection: trim(brief.sections.connection), meaning: trim(brief.sections.meaning), forThisPage: mine, watch: trim(brief.sections.watch), gaps: trim(brief.sections.gaps) };
  }
  return {
    themeId: theme.id,
    memberIds: theme.member_ids,
    title: brief ? brief.title : null,
    briefMd: brief ? brief.briefMd : null,
    generatedAt: brief ? brief.generatedAt : null,
    memberCount: theme.member_ids.length,
    density: typeof theme.density === "number" ? theme.density : null,
    stale: brief ? brief.stale : false,
    supersedesThemeId: brief ? brief.supersedesThemeId : null,
    hasBrief: Boolean(brief),
    cluster: brief ? null : clusterOf(theme, pages, linkedBy),
    sections,
    ramificationsMissing,
    pages,
    membersByPage,
    forwardOutlook: deriveThemeForwardOutlook({ memberIds: theme.member_ids, pivotIds: (theme.pivots ?? []).map((p) => p?.id).filter((id): id is string => typeof id === "string"), members, events, asOfIso }),
  };
}
export type ThemeAnalysisView = NonNullable<ReturnType<typeof themeAnalysisView>>;

const joinNames = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
/** A theme's label when no brief names it: how many items it links and where it spans, shortened to 56 characters. */
function deriveThemeLabel(input: { pages?: Array<{ label?: string }>; memberCount?: number } = {}): string {
  const n = input.memberCount && input.memberCount > 0 ? Math.floor(input.memberCount) : 0;
  const lead = n > 0 ? `${n} linked ${n === 1 ? "item" : "items"}` : "Linked items";
  const names = (input.pages ?? []).map((p) => p?.label).filter((l): l is string => typeof l === "string" && !!l.trim());
  let out = `${lead}${names.length === 0 ? "" : names.length === 1 ? ` on ${names[0]}` : ` across ${joinNames(names)}`}`;
  if (out.length > MAX_THEME_LABEL_CHARS && names.length > 1) out = `${lead} across ${names.length} pages`;
  if (out.length > MAX_THEME_LABEL_CHARS) {
    const cut = lead.slice(0, MAX_THEME_LABEL_CHARS);
    const at = cut.lastIndexOf(" ");
    out = (at > 0 && lead.length > MAX_THEME_LABEL_CHARS ? cut.slice(0, at) : cut).trimEnd();
  }
  return out;
}

/** Ruling 59's theme scope: a theme is three or more items or spans two or more surfaces; a pair on one surface is not a theme across the corpus. */
export const inThemeScope = (memberCount: number, surfaceCount: number): boolean => memberCount >= 3 || surfaceCount >= 2;

/** The one ranking of themes: a fresh brief first, then the surfaces spanned, then the member count, then convergence, the id breaking ties. */
export const compareThemes = (a: { hasBrief: boolean; surfaces: number; members: number; convergence: number; id: string }, b: typeof a): number => Number(b.hasBrief) - Number(a.hasBrief) || b.surfaces - a.surfaces || b.members - a.members || b.convergence - a.convergence || (a.id < b.id ? -1 : 1);

/** The theme chips of a list page: the themes in scope that touch the surface (or span `minPages`), ranked by compareThemes, each linking to a member on this surface. */
export function themeChips(input: { themes: readonly ThemeRow[]; items: readonly MemberRow[]; briefs?: readonly BriefRow[]; lineage?: Lineage; surface?: string | null; minPages?: number; max?: number }) {
  const { themes, items, briefs = [], lineage = [], surface = null, minPages = 1, max = 6 } = input;
  const byId = new Map(items.filter((it) => it && trim(it.title)).map((it) => [it.id, it]));
  const live = themes.filter((t) => t && typeof t.id === "string" && Array.isArray(t.member_ids));
  const liveThemeIds = new Set(live.map((t) => t.id));
  const out: Array<{ themeId: string; convergence: number; href: string; label: string; itemTitle: string; briefTitle: string | null; meaning: string | null; memberCount: number; pages: Array<{ surface: string; label: string }>; hasBrief: boolean; stale: boolean; links: Array<{ title: string; href: string }> }> = [];
  for (const t of live) {
    const pivotRank = new Map((t.pivots ?? []).map((p, i) => [p?.id, i]));
    const members = t.member_ids.flatMap((id) => {
      const it = byId.get(id);
      const s = it ? surfaceOf(it.item_type, it.domain) : "";
      return it && label(s) ? [{ id, title: it.title.trim(), href: `/${s}/${encodeURIComponent(it.legacy_id || id)}`, surface: s }] : [];
    });
    members.sort((a, b) => (pivotRank.get(a.id) ?? 1e9) - (pivotRank.get(b.id) ?? 1e9) || a.title.localeCompare(b.title));
    const pageSet = new Set(members.map((m) => m.surface));
    if (pageSet.size < minPages || !inThemeScope(t.member_ids.length, pageSet.size)) continue;
    const target = surface ? members.find((m) => m.surface === surface) : members[0];
    if (!target) continue;
    const resolved = resolveBriefForTheme(t, briefs, { liveThemeIds, lineage });
    const brief = briefHolds(t, resolved.brief as BriefRow | null, resolved.stale) ? (resolved.brief as BriefRow) : null;
    const others = members.filter((m) => m.id !== target.id);
    const pages = SURFACE_ORDER.filter((s) => pageSet.has(s)).map((s) => ({ surface: s, label: label(s) as string }));
    const briefTitle = brief ? trim(brief.title) : null;
    out.push({
      themeId: t.id,
      convergence: typeof t.convergence === "number" ? t.convergence : 0,
      href: target.href,
      label: briefTitle ?? deriveThemeLabel({ pages, memberCount: t.member_ids.length }),
      itemTitle: target.title,
      briefTitle: brief?.title ?? null, meaning: (surface && brief?.sections && SURFACE_HEADING[surface] ? trim(parseRamifications(String(brief.sections.ramifications ?? "")).subs.get(SURFACE_HEADING[surface] ?? "")) : null) ?? trim(brief?.sections?.meaning) ?? trim(brief?.sections?.connection) ?? trim((brief?.brief_md ?? "").split(/\r?\n\r?\n/).map((p) => p.trim()).find((p) => p.length > 40 && !p.startsWith("#") && !p.startsWith("**") && !p.startsWith("|"))?.replace(/\*\*|`/g, "").slice(0, 220)) ?? null,
      memberCount: t.member_ids.length,
      pages,
      hasBrief: Boolean(brief),
      stale: brief ? resolved.stale : false,
      links: [...others.filter((m) => m.surface !== target.surface), ...others.filter((m) => m.surface === target.surface)].slice(0, MAX_CHIP_MEMBER_LINKS).map(({ title, href }) => ({ title, href })),
    });
  }
  out.sort((a, b) => compareThemes({ hasBrief: a.hasBrief, surfaces: a.pages.length, members: a.memberCount, convergence: a.convergence, id: a.themeId }, { hasBrief: b.hasBrief, surfaces: b.pages.length, members: b.memberCount, convergence: b.convergence, id: b.themeId }));
  return out.slice(0, Math.max(0, max)).map((c) => ({ themeId: c.themeId, href: c.href, label: c.label, itemTitle: c.itemTitle, meaning: c.meaning, memberCount: c.memberCount, pages: c.pages, hasBrief: c.hasBrief, stale: c.stale, links: c.links }));
}
