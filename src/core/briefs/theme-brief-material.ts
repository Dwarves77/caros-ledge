// Ported from old_repo/scripts/turns/theme-briefs/data.mjs (lines 1-243)
// The material a theme brief is written from, read once for the union of the themes' members: members, grounded FACT claims, forward events, intra-theme edges and the gaps the connection layer computes. Which themes
// need a brief (none, stale or superseded), one theme's export bundle within a character budget with every cut counted, and the validator's context. Every read throws on a database error: a failed read is never an empty list.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { isYearOnlyTarget } from "@/core/flywheel/clusters";
import { detectGaps } from "@/core/flywheel/gaps";
import { computeMemberHash, lineageFromThemeDelta, resolveBriefForTheme } from "@/core/flywheel/themes";
import { surfaceOf } from "@/core/routing";
import { admissibleRows, type AdmissibleRows } from "@/core/derived/admissible";

import { figureCoverage, figureTokens, type ClaimComparator, type ThemeContext } from "./theme-brief-contract";

export interface ThemeRow { id: string; member_ids: string[] | null; dominant_signals?: unknown; surfaces: string[] | null; density?: number | null; convergence?: number | null; pivots?: { id: string }[] | null }
export interface MemberItem { id: string; title: string | null; item_type: string | null; domain: number | null; jurisdiction_iso: string[] | null; priority: string | null; summary: string | null; added_date: string | null }
export interface ThemeClaim { id: string; intelligence_item_id: string; claim_kind: string; claim_text: string; source_id: string | null; source_span?: string | null }
export interface ThemeEvent { id: string; intelligence_item_id: string; event_date: string; date_precision: string; event_kind: string; obligation_text: string; source_span: string | null; confidence: string | null }
export interface ThemeEdge { source_item_id: string; target_item_id: string; relationship: string | null; origin: string | null; basis: { detail?: string }[] | null; score: number | null }
export interface ThemeMaterial { items: MemberItem[]; claims: ThemeClaim[]; events: ThemeEvent[]; edges: ThemeEdge[]; jurisdictionWeights: Record<string, unknown> }
export interface StoredBrief { theme_id: string; member_hash: string; member_count: number; title: string | null; generated_at: string | null; generated_by: string | null; member_ids: string[] | null }

const THEME_COLUMNS = "id, member_ids, dominant_signals, surfaces, density, convergence, pivots";
const MEMBER_COLUMNS = "id, title, item_type, domain, jurisdiction_iso, priority, summary, added_date";
const CLAIM_COLUMNS = "id, intelligence_item_id, claim_kind, claim_text, source_id, source_span";
const EVENT_COLUMNS = "id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_span, confidence";
const EDGE_COLUMNS = "source_item_id, target_item_id, relationship, origin, basis, score";
const BRIEF_COLUMNS = "theme_id, member_hash, member_count, title, generated_at, generated_by, member_ids";

/** Live themes, all of them or the named ids. */
export async function loadThemes(sb: Db, themeIds: readonly string[] | null = null): Promise<ThemeRow[]> {
  if (themeIds) {
    return fetchAllByIdChunks(themeIds, async (slice) => {
      const { data, error } = await sb.from("connection_themes").select(THEME_COLUMNS).in("id", slice);
      if (error) throw new Error(`connection_themes read failed: ${error.message}`);
      return (data ?? []) as ThemeRow[];
    });
  }
  return fetchAllRows<ThemeRow>((from, to) => sb.from("connection_themes").select(THEME_COLUMNS).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 });
}

/** Every stored theme brief (the structured columns exist: the probe the old reader needed is gone). */
export const loadBriefs = (sb: Db): Promise<StoredBrief[]> => fetchAllRows<StoredBrief>((from, to) => sb.from("theme_briefs").select(BRIEF_COLUMNS).order("theme_id", { ascending: true }).range(from, to) as never, { cap: 50_000 });

/** The prior-to-new theme id pairs of the latest finished corpus pass. */
export async function loadLineage(sb: Db): Promise<{ prior_id: string; new_id: string }[]> {
  const { data, error } = await sb.from("connection_theme_runs").select("id, started_at, theme_delta").eq("status", "ok").order("started_at", { ascending: false }).limit(1);
  if (error) throw new Error(`connection_theme_runs read failed: ${error.message}`);
  return lineageFromThemeDelta((data?.[0] as { theme_delta?: never } | undefined)?.theme_delta ?? null);
}

const byIds = <T>(sb: Db, table: string, columns: string, ids: readonly string[], idColumn: string, order: string): Promise<T[]> =>
  fetchAllByIdChunks(ids, async (slice) => {
    const rows = await fetchAllRows<T>((from, to) => sb.from(table).select(columns).in(idColumn, slice).order(order, { ascending: true }).range(from, to) as never, { cap: 500_000 });
    return rows;
  }, { manyPerId: true });

/** Which workspace profile the home jurisdictions come from: one named organisation's, or the union of every workspace's (a theme is corpus-wide, so its gaps are measured against everyone's homes). Never "whichever row comes first". */
export type HomeScope = { orgId: string } | "all-workspaces";
/** jurisdiction to weight for the scope. A union takes the larger numeric weight per jurisdiction, rows read in organisation order. A failed read throws. */
async function loadHomeJurisdictions(sb: Db, scope: HomeScope): Promise<Record<string, unknown>> {
  const read = scope === "all-workspaces"
    ? await fetchAllRows<{ org_id: string; jurisdiction_weights: unknown }>((from, to) => sb.from("workspace_settings").select("org_id, jurisdiction_weights").order("org_id", { ascending: true }).range(from, to) as never, { cap: 100_000 })
    : await (async () => {
        const r = await sb.from("workspace_settings").select("org_id, jurisdiction_weights").eq("org_id", scope.orgId).maybeSingle();
        if (r.error) throw new Error(`workspace_settings read failed: ${r.error.message}`);
        return r.data ? [r.data as { org_id: string; jurisdiction_weights: unknown }] : [];
      })();
  const out: Record<string, unknown> = {};
  for (const row of read) {
    const w = row.jurisdiction_weights;
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    for (const [k, v] of Object.entries(w as Record<string, unknown>)) out[k] = typeof v === "number" && typeof out[k] === "number" ? Math.max(v, out[k] as number) : (out[k] ?? v);
  }
  return out;
}

export interface MaterialOpts {
  homes?: HomeScope;
  seams?: ThemeBriefSeams;
}
/**
 * The two readers the theme-brief path goes through, behind ONE member: the comparator of a listed claim against its grounded text (R2a's typed figure comparator) and the admissible-row predicate
 * (core/derived/admissible.ts, the one every reader takes): members, claims and events that fail it never reach the author.
 */
export interface ThemeBriefSeams { comparator: ClaimComparator; admissible: AdmissibleRows }
const themeBriefSeams: ThemeBriefSeams = { comparator: figureCoverage, admissible: admissibleRows };
/**
 * Members, grounded FACT claims, forward events and intra-theme edges for a set of themes, read once for the union of their members, and ONLY admissible rows: a member quarantined or archived since the pass and a suppressed
 * claim are not material (F:16). The home jurisdictions come from the scope named in `opts.homes` (default: every workspace), never from an arbitrary row (F:17).
 */
export async function loadThemeMaterial(sb: Db, themes: readonly ThemeRow[], opts: MaterialOpts = {}): Promise<ThemeMaterial> {
  const memberIds = [...new Set(themes.flatMap((t) => t.member_ids ?? []))].sort();
  if (!memberIds.length) return { items: [], claims: [], events: [], edges: [], jurisdictionWeights: {} };
  const admissible = (opts.seams ?? themeBriefSeams).admissible;
  const live = await admissible.itemIds(sb, memberIds);
  const [items, claims, events, edges] = [
    (await byIds<MemberItem>(sb, "intelligence_items", MEMBER_COLUMNS, memberIds, "id", "id")).filter((i) => live.has(i.id)),
    await admissible.claims(sb, (await byIds<ThemeClaim>(sb, "section_claim_provenance", CLAIM_COLUMNS, memberIds, "intelligence_item_id", "id")).filter((c) => c.claim_kind === "FACT")),
    (await byIds<ThemeEvent>(sb, "item_forward_events", EVENT_COLUMNS, memberIds, "intelligence_item_id", "id")).filter((e) => live.has(e.intelligence_item_id)),
    (await byIds<ThemeEdge>(sb, "item_cross_references", EDGE_COLUMNS, memberIds, "source_item_id", "target_item_id")).filter((e) => live.has(e.source_item_id) && live.has(e.target_item_id)),
  ];
  return { items, claims, events, edges, jurisdictionWeights: await loadHomeJurisdictions(sb, opts.homes ?? "all-workspaces") };
}

/** The gaps the connection layer computes for each theme, keyed by theme id: same inputs the corpus pass gives it. */
export function computeThemeGaps(themes: readonly ThemeRow[], material: ThemeMaterial): Map<string, { type: string; description: string; recommended_actions: unknown; evidence: unknown }[]> {
  const jurisdictionsByMember: Record<string, string[]> = {};
  for (const it of material.items) if (it.jurisdiction_iso) jurisdictionsByMember[it.id] = it.jurisdiction_iso;
  const shaped = themes.map((t) => ({ id: t.id, members: t.member_ids ?? [], surfaces: t.surfaces ?? [], pivots: Array.isArray(t.pivots) ? (t.pivots as never) : [] }));
  const out = new Map<string, { type: string; description: string; recommended_actions: unknown; evidence: unknown }[]>();
  for (const g of detectGaps(shaped as never, { profile: { jurisdictions: material.jurisdictionWeights }, jurisdictionsByMember })) {
    out.set(g.subject_ref, [...(out.get(g.subject_ref) ?? []), { type: g.type, description: g.description, recommended_actions: g.recommended_actions, evidence: g.evidence }]);
  }
  return out;
}

/** The validator's context: themes, per-member claim and event id sets and titles, the gap lists, and the figure tokens the intra-theme edge basis names (system facts the author is told to name). */
export function buildValidationContext(themes: readonly ThemeRow[], material: ThemeMaterial, gapsByTheme: ThemeContext["gapsByTheme"], seams: ThemeBriefSeams = themeBriefSeams): ThemeContext {
  const themesById: ThemeContext["themesById"] = new Map(themes.map((t) => [t.id, { id: t.id, member_ids: t.member_ids ?? [], surfaces: t.surfaces ?? [] }]));
  const membersById: ThemeContext["membersById"] = new Map(material.items.map((it) => [it.id, { title: it.title, claim_ids: new Set<string>(), event_ids: new Set<string>() }]));
  for (const c of material.claims) membersById.get(c.intelligence_item_id)?.claim_ids.add(c.id);
  for (const e of material.events) membersById.get(e.intelligence_item_id)?.event_ids.add(e.id);
  const basisTokensByTheme = new Map<string, Set<string>>();
  for (const t of themes) {
    const members = new Set(t.member_ids ?? []);
    const tokens = new Set<string>();
    for (const e of material.edges) if (members.has(e.source_item_id) && members.has(e.target_item_id)) for (const b of Array.isArray(e.basis) ? e.basis : []) for (const tk of figureTokens(b?.detail)) tokens.add(tk);
    basisTokensByTheme.set(t.id, tokens);
  }
  const groundedText = new Map<string, readonly string[]>([
    ...material.claims.map((c): [string, readonly string[]] => [c.id, [c.claim_text, c.source_span ?? ""].filter(Boolean)]),
    ...material.events.map((e): [string, readonly string[]] => [e.id, [e.obligation_text, e.event_date, e.source_span ?? ""].filter(Boolean)]),
  ]);
  return { themesById, membersById, groundedText, comparator: seams.comparator, ...(gapsByTheme ? { gapsByTheme } : {}), basisTokensByTheme };
}

export interface ThemeNeed { theme: ThemeRow; reason: "no_brief" | "stale" | "superseded"; prior: StoredBrief | null; supersedes_theme_id: string | null }
/** Which themes need a brief, and why: skipped only when a brief stored under the theme's own id is current. Order: convergence descending, then id. */
export function themesNeedingBrief(themes: readonly ThemeRow[], briefs: readonly StoredBrief[], opts: { lineage?: readonly { prior_id: string; new_id: string }[] } = {}): ThemeNeed[] {
  const liveThemeIds = new Set(themes.map((t) => t.id));
  const out: ThemeNeed[] = [];
  for (const theme of themes) {
    const r = resolveBriefForTheme({ id: theme.id, member_ids: theme.member_ids ?? [] } as never, briefs as never, { liveThemeIds, ...(opts.lineage ? { lineage: opts.lineage } : {}) });
    if (r.match === "exact" && !r.stale) continue;
    out.push({ theme, reason: r.match === "exact" ? "stale" : r.match === null ? "no_brief" : "superseded", prior: r.brief as StoredBrief | null, supersedes_theme_id: r.supersedes_theme_id });
  }
  return out.sort((a, b) => (b.theme.convergence ?? 0) - (a.theme.convergence ?? 0) || (a.theme.id < b.theme.id ? -1 : 1));
}

const size = (x: unknown): number => JSON.stringify(x).length;
const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => void m.set(k, [...(m.get(k) ?? []), v]);

/**
 * One theme's bundle within a character budget, with honest truncation reporting. Fixed part first (theme fields, gaps, edges with their full basis, highest score first), then members in pivot order, each with its
 * summary, grounded claims and forward events. A member that does not fit whole is cut claim by claim; a member whose bare record does not fit is omitted. Every cut is counted in `truncation`.
 */
export function buildThemeBundle(need: ThemeNeed, material: ThemeMaterial, gaps: readonly unknown[] | undefined, opts: { charBudget: number }) {
  const { theme, reason, prior, supersedes_theme_id } = need;
  const memberIds = theme.member_ids ?? [];
  const memberSet = new Set(memberIds);
  const itemById = new Map(material.items.map((i) => [i.id, i]));
  const claimsBy = new Map<string, ThemeClaim[]>();
  for (const c of material.claims) if (memberSet.has(c.intelligence_item_id)) push(claimsBy, c.intelligence_item_id, c);
  const eventsBy = new Map<string, ThemeEvent[]>();
  for (const e of material.events) if (memberSet.has(e.intelligence_item_id)) push(eventsBy, e.intelligence_item_id, e);
  const allEdges = material.edges.filter((e) => memberSet.has(e.source_item_id) && memberSet.has(e.target_item_id)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || `${a.source_item_id}${a.target_item_id}`.localeCompare(`${b.source_item_id}${b.target_item_id}`));
  const head = {
    theme_id: theme.id, member_hash: computeMemberHash(memberIds), needs: reason, supersedes_theme_id: supersedes_theme_id ?? null,
    prior_brief: prior ? { theme_id: prior.theme_id, title: prior.title ?? null, generated_at: prior.generated_at ?? null } : null,
    member_count: memberIds.length, surfaces: theme.surfaces ?? [], convergence: theme.convergence ?? null, pivots: theme.pivots ?? [], dominant_signals: theme.dominant_signals ?? [], gaps: gaps ?? [],
  };
  let used = size(head);
  const edges: ThemeEdge[] = [];
  for (const e of allEdges) {
    if (used + size(e) > opts.charBudget) break;
    edges.push(e);
    used += size(e);
  }
  const rank = new Map((Array.isArray(theme.pivots) ? theme.pivots : []).map((p, i) => [p.id, i]));
  const ordered = [...memberIds].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99) || (a < b ? -1 : 1));
  const members: unknown[] = [];
  const omitted: { id: string; title: string | null }[] = [];
  const cut = { claimsTotal: 0, claimsOmitted: 0, eventsTotal: 0, eventsOmitted: 0, yearOnly: 0 };
  for (const id of ordered) {
    const it = itemById.get(id);
    const claims = (claimsBy.get(id) ?? []).map((c) => ({ claim_id: c.id, kind: c.claim_kind, claim_text: c.claim_text, source_id: c.source_id ?? null }));
    const allEvents = eventsBy.get(id) ?? [];
    const events = allEvents.filter((e) => !isYearOnlyTarget(e)).map((e) => ({ event_id: e.id, event_date: e.event_date, date_precision: e.date_precision, event_kind: e.event_kind, obligation_text: e.obligation_text, source_span: e.source_span, confidence: e.confidence }));
    cut.claimsTotal += claims.length;
    cut.eventsTotal += events.length;
    cut.yearOnly += allEvents.length - events.length;
    const rec = { id, title: it?.title ?? null, item_type: it?.item_type ?? null, surface: it ? surfaceOf(it.item_type, it.domain) : "uncategorized", jurisdictions: it?.jurisdiction_iso ?? [], priority: it?.priority ?? null, summary: it?.summary ?? null, claims: [] as unknown[], forward_events: [] as unknown[] };
    if (used + size(rec) > opts.charBudget) {
      omitted.push({ id, title: it?.title ?? null });
      cut.claimsOmitted += claims.length;
      cut.eventsOmitted += events.length;
      continue;
    }
    used += size(rec);
    for (const ev of events) {
      if (used + size(ev) > opts.charBudget) cut.eventsOmitted += 1;
      else {
        rec.forward_events.push(ev);
        used += size(ev);
      }
    }
    for (const c of claims) {
      if (used + size(c) > opts.charBudget) cut.claimsOmitted += 1;
      else {
        rec.claims.push(c);
        used += size(c);
      }
    }
    members.push(rec);
  }
  return {
    ...head, members, intra_theme_edges: edges,
    truncation: { char_budget: opts.charBudget, chars_used: used, members_total: ordered.length, members_included: members.length, members_omitted: omitted.length, omitted_members: omitted, claims_total: cut.claimsTotal, claims_omitted: cut.claimsOmitted, forward_events_total: cut.eventsTotal, forward_events_omitted: cut.eventsOmitted, forward_events_dropped_year_only_target: cut.yearOnly, edges_total: allEdges.length, edges_omitted: allEdges.length - edges.length },
  };
}
