// Ported from old_repo/src/lib/research/theme-brief.mjs (lines 1-303)
// The cross-page theme view (research-ops.md): which theme an item belongs to, the brief that explains it (current or stale, by member hash and lineage), the analysis a detail page
// draws (members grouped by page, the sections of the brief, what is missing said in words) and the chips a list page draws. Pure: the rows come in already read. The detail page is
// the first consumer; the dashboard and the shell read the same views later.
import { SURFACE_HEADING, parseRamifications } from "@/core/briefs/theme-brief-contract";
import { resolveBriefForTheme } from "@/core/flywheel";
import { SURFACE_LABELS, SURFACE_ORDER, surfaceOf } from "@/core/routing";

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
}
type Lineage = { prior_id: string; new_id: string }[];

export const MAX_MEMBERS_PER_PAGE = 6;
const MAX_CHIP_MEMBER_LINKS = 3;
export const MAX_THEME_LABEL_CHARS = 56;
const SIGNAL_PHRASES: Record<string, string> = { shared_source: "Shared source", shared_scenario: "Shared scenarios", shared_compliance_object: "Shared obligated parties", shared_jurisdiction_topic: "Shared jurisdiction and topic" };
const trim = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const label = (s: string): string | undefined => SURFACE_LABELS[s];

export const themeForItem = (themes: readonly ThemeRow[] | null | undefined, itemId: string | null | undefined): ThemeRow | null => (itemId && themes ? (themes.find((t) => t && Array.isArray(t.member_ids) && t.member_ids.includes(itemId)) ?? null) : null);

/** The brief that explains the item's theme: exact, or inherited from a dissolved theme (always stale). */
function briefForItem(itemId: string, themes: readonly ThemeRow[], briefs: readonly BriefRow[], lineage: Lineage) {
  const theme = themeForItem(themes, itemId);
  if (!theme) return null;
  const resolved = resolveBriefForTheme(theme, briefs, { liveThemeIds: new Set(themes.map((t) => t.id)), lineage });
  const b = resolved.brief as BriefRow | null;
  return b ? { title: b.title, briefMd: b.brief_md, generatedAt: b.generated_at ?? null, stale: resolved.stale, supersedesThemeId: resolved.supersedes_theme_id, sections: b.sections && typeof b.sections === "object" && !Array.isArray(b.sections) ? b.sections : null } : null;
}

/** The theme analysis of one item on one surface: members by page (other pages first), the brief's sections, and the absence worded when there is no brief. */
export function themeAnalysisView(input: { itemId: string; surface: string; themes: readonly ThemeRow[]; briefs: readonly BriefRow[]; lineage?: Lineage; members?: readonly MemberRow[] }) {
  const { itemId, surface, themes, briefs, lineage = [], members = [] } = input;
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
    title: brief ? brief.title : null,
    briefMd: brief ? brief.briefMd : null,
    generatedAt: brief ? brief.generatedAt : null,
    memberCount: theme.member_ids.length,
    density: typeof theme.density === "number" ? theme.density : null,
    stale: brief ? brief.stale : false,
    supersedesThemeId: brief ? brief.supersedesThemeId : null,
    hasBrief: Boolean(brief),
    absence: brief ? null : "A brief for this theme has not been written yet, so what this connection means is not stated here.",
    sections,
    ramificationsMissing,
    pages,
    membersByPage,
  };
}
export type ThemeAnalysisView = NonNullable<ReturnType<typeof themeAnalysisView>>;

const joinNames = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
function signalPhrase(signal: unknown): string | null {
  if (typeof signal !== "string" || !signal.trim()) return null;
  const words = signal.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return SIGNAL_PHRASES[signal.trim()] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** A theme's label when no brief names it: its strongest signal, where it spans, shortened to 56 characters. */
export function deriveThemeLabel(input: { signals?: ThemeRow["dominant_signals"]; pages?: Array<{ label?: string }>; memberCount?: number } = {}): string {
  const ranked = (input.signals ?? []).filter((x) => x && typeof x.signal === "string" && x.signal.trim()).sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
  const n = input.memberCount && input.memberCount > 0 ? Math.floor(input.memberCount) : 0;
  const lead = (ranked[0] ? signalPhrase(ranked[0].signal) : null) ?? (n > 0 ? `${n} linked ${n === 1 ? "item" : "items"}` : "Linked items");
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

/** The theme chips of a list page: the themes that touch the surface (or span `minPages`), strongest convergence first, each linking to a member on this surface. */
export function themeChips(input: { themes: readonly ThemeRow[]; items: readonly MemberRow[]; briefs?: readonly BriefRow[]; lineage?: Lineage; surface?: string | null; minPages?: number; max?: number }) {
  const { themes, items, briefs = [], lineage = [], surface = null, minPages = 1, max = 6 } = input;
  const byId = new Map(items.filter((it) => it && trim(it.title)).map((it) => [it.id, it]));
  const live = themes.filter((t) => t && typeof t.id === "string" && Array.isArray(t.member_ids));
  const liveThemeIds = new Set(live.map((t) => t.id));
  const out: Array<{ themeId: string; convergence: number; href: string; label: string; itemTitle: string; briefTitle: string | null; memberCount: number; pages: Array<{ surface: string; label: string }>; hasBrief: boolean; stale: boolean; links: Array<{ title: string; href: string }> }> = [];
  for (const t of live) {
    const pivotRank = new Map((t.pivots ?? []).map((p, i) => [p?.id, i]));
    const members = t.member_ids.flatMap((id) => {
      const it = byId.get(id);
      const s = it ? surfaceOf(it.item_type, it.domain) : "";
      return it && label(s) ? [{ id, title: it.title.trim(), href: `/${s}/${encodeURIComponent(it.legacy_id || id)}`, surface: s }] : [];
    });
    members.sort((a, b) => (pivotRank.get(a.id) ?? 1e9) - (pivotRank.get(b.id) ?? 1e9) || a.title.localeCompare(b.title));
    const pageSet = new Set(members.map((m) => m.surface));
    if (pageSet.size < minPages) continue;
    const target = surface ? members.find((m) => m.surface === surface) : members[0];
    if (!target) continue;
    const resolved = resolveBriefForTheme(t, briefs, { liveThemeIds, lineage });
    const brief = resolved.brief as BriefRow | null;
    const others = members.filter((m) => m.id !== target.id);
    const pages = SURFACE_ORDER.filter((s) => pageSet.has(s)).map((s) => ({ surface: s, label: label(s) as string }));
    const briefTitle = brief ? trim(brief.title) : null;
    out.push({
      themeId: t.id,
      convergence: typeof t.convergence === "number" ? t.convergence : 0,
      href: target.href,
      label: briefTitle ?? deriveThemeLabel({ signals: t.dominant_signals, pages, memberCount: t.member_ids.length }),
      itemTitle: target.title,
      briefTitle: brief?.title ?? null,
      memberCount: t.member_ids.length,
      pages,
      hasBrief: Boolean(brief),
      stale: brief ? resolved.stale : false,
      links: [...others.filter((m) => m.surface !== target.surface), ...others.filter((m) => m.surface === target.surface)].slice(0, MAX_CHIP_MEMBER_LINKS).map(({ title, href }) => ({ title, href })),
    });
  }
  out.sort((a, b) => b.convergence - a.convergence || (a.themeId < b.themeId ? -1 : 1));
  return out.slice(0, Math.max(0, max)).map((c) => ({ themeId: c.themeId, href: c.href, label: c.label, itemTitle: c.itemTitle, memberCount: c.memberCount, pages: c.pages, hasBrief: c.hasBrief, stale: c.stale, links: c.links }));
}
