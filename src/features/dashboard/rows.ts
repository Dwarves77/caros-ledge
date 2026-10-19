// Ported from old_repo/src/lib/dashboard/brief-rows.ts (lines 1-256)
// Ported from old_repo/src/lib/dashboard/recent-changes-window.mjs (lines 1-10)
// Ported from old_repo/src/components/dashboard/brief-title.ts (lines 1-15)
// The Dashboard's row logic, pure: which items the two cards draw, in what order, with what labels. Nothing here reads a clock (the caller passes `now`) or a table. The cards are built from ONE corpus (the
// due-next read and the by-id backfill of the changed items); an item the read gate does not return is not drawn.
import { dueInfo, toListRowFields, type ListRowFields } from "@/core/lists";
import { formatDate } from "@/core/shared";
import { rowMeta } from "@/features/market/lib/item-type";
import type { Resource } from "@/core/types";
import { urgencyScore, type UrgencyContext } from "@/core/urgency/scoring";

/** The intelligence surfaces the dashboard counts, in order: the ONE list the masthead's "across N surfaces" and the "Across the platform" rail card both read, so the two cannot disagree. */
export const SURFACES = [
  { key: "regulations", label: "Regulations", note: "Binding law, agency rules, court decisions", href: "/regulations" },
  { key: "marketIntel", label: "Market Intel", note: "Price series, corporate moves, capital", href: "/market" },
  { key: "research", label: "Research", note: "Horizon-scan findings", href: "/research" },
  { key: "operations", label: "Operations", note: "Regional cost, feasibility, infrastructure", href: "/operations" },
] as const;
/** The items the rail card's four counts add up to: the masthead's number is this, so it is the rail's number. */
export const surfaceItemTotal = (surfaces: Readonly<Record<(typeof SURFACES)[number]["key"], number>>): number => SURFACES.reduce((n, s) => n + surfaces[s.key], 0);

export const DUE_NEXT_CAP = 5;
export const CHANGED_CAP = 6;
/** How many distinct changed items are read in full and ranked; the cards draw CHANGED_CAP of them. */
export const CANDIDATE_WINDOW = 48;
/** The Due-next card's aside names a week: a row 7 or more days out is past it, and the label then says how far the card reaches. */
const STATED_WINDOW_DAYS = 7;
const BUILD_MODE_WINDOW_DAYS = 90;
const LIVE_WINDOW_DAYS = 7;

/** One row of get_workspace_recent_changes: a new item or an updated one, with the date of the change. */
export interface FeedRow {
  id: string;
  legacy_id: string | null;
  title: string;
  priority: string | null;
  effective_priority: string | null;
  added_date: string | null;
  change_kind: "new" | "updated";
  change_date: string | null;
}
/** A changed item read in full, with the cargo verticals the urgency composite weighs. */
export interface Candidate {
  /** intelligence_items.id, the key the feed carries. */
  uuid: string;
  resource: Resource;
  verticals: string[];
}
export interface BriefRow extends ListRowFields {
  isNew?: boolean;
  isUpdated?: boolean;
  /** The item_changelog field that made an UPDATED row ("full_brief" or "timeline"). */
  updatedField?: string | undefined;
  changeDate?: string | undefined;
  /** Due-next only: whole days to the row's binding date, carried so the card's window label comes from the SELECTED rows. */
  dueDays?: number;
}

/** The What-changed window: 90 days while the scrape cadence is off (build mode, CLAUDE.md rule 16), 7 days with a cadence. */
export const recentChangesWindowDays = (cadence: string | null | undefined): number => (cadence === "off" || cadence == null ? BUILD_MODE_WINDOW_DAYS : LIVE_WINDOW_DAYS);

/** "<FIRST NAME>'S BRIEF", else the workspace name, else "YOUR BRIEF". */
export function deriveBriefTitle(firstName: string | null, orgName: string): string {
  if (firstName) return `${firstName.toUpperCase()}'S BRIEF`;
  return orgName ? orgName.toUpperCase() : "YOUR BRIEF";
}
/** The first token of a display name, usable even when the name fell back to an e-mail address. */
export function firstTokenOf(displayName: string | null | undefined): string | null {
  const name = displayName?.trim();
  return name ? ((name.split("@")[0] ?? "").split(/\s+/)[0] || null) : null;
}

/** The items with the nearest future binding date, soonest first, capped. No date, no row. */
export function buildDueNextRows(resources: readonly Resource[], now: Date, cap = DUE_NEXT_CAP): BriefRow[] {
  return resources
    .flatMap((r) => {
      const due = dueInfo(r, now);
      return due ? [{ r, due }] : [];
    })
    .sort((a, b) => a.due.daysNum - b.due.daysNum)
    .slice(0, cap)
    .map(({ r, due }) => ({ ...toListRowFields(r, now), meta: rowMeta(r), dueDays: due.daysNum }));
}

/**
 * The ids to read in full for the cards: the Due-next candidates and the first CANDIDATE_WINDOW DISTINCT ids of the change feed. The feed is de-duplicated BEFORE the cut, so a feed that repeats an id
 * never leaves the cards short of rows (B-1985: the old count ran over the raw feed while the rows were de-duplicated).
 */
export function selectBriefResources(dueIds: readonly string[], feed: readonly FeedRow[]): { dueIds: string[]; changeIds: string[] } {
  return { dueIds: [...new Set(dueIds)], changeIds: [...new Set(feed.map((f) => f.id))].slice(0, CANDIDATE_WINDOW) };
}

/**
 * The changed items the card draws: the feed's first CANDIDATE_WINDOW distinct items that the read gate returned in full, ranked by the sector-weighted urgency composite (BUILD-PLAN ruling 6; the feed's own order
 * breaks ties), capped. A new item is NEW and an updated one UPDATED, never both (the feed already excludes a new item from the updated set). A feed item the gate did not return is not drawn at all.
 */
export function buildChangedRows(feed: readonly FeedRow[], candidates: readonly Candidate[], changelogField: Readonly<Record<string, string>>, now: Date, ctx: UrgencyContext = {}, cap = CHANGED_CAP): BriefRow[] {
  const byUuid = new Map(candidates.map((c) => [c.uuid, c]));
  const { changeIds } = selectBriefResources([], feed);
  const first = new Map<string, FeedRow>();
  for (const f of feed) if (!first.has(f.id)) first.set(f.id, f);
  return changeIds
    .flatMap((id, order) => {
      const f = first.get(id);
      const c = byUuid.get(id);
      if (!f || !c) return [];
      const score = urgencyScore({ priority: c.resource.priority, impact: c.resource.impactScores ?? null, daysToNext: dueInfo(c.resource, now)?.daysNum ?? null, jurisdiction: c.resource.jurisdiction ?? null, verticals: c.verticals }, ctx);
      return [{ f, c, score, order }];
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, cap)
    .map(({ f, c }): BriefRow => {
      const isUpdated = f.change_kind === "updated";
      return { ...toListRowFields(c.resource, now), meta: rowMeta(c.resource), isNew: !isUpdated, isUpdated, updatedField: isUpdated ? changelogField[f.id] : undefined, changeDate: f.change_date ?? f.added_date ?? undefined };
    });
}

/** The row's kind and date prefix, computed once: "New", "Updated · brief updated Oct 13, 2026", "Updated · timeline added Oct 13, 2026" (the date formatted, never the raw database string). */
export function changeRowPrefix(row: Pick<BriefRow, "isNew" | "isUpdated" | "updatedField" | "changeDate">): string | null {
  if (row.isNew) return "New";
  if (!row.isUpdated) return null;
  const what = row.updatedField === "timeline" ? "timeline added" : "brief updated";
  return row.changeDate ? `Updated · ${what} ${formatDate(row.changeDate)}` : `Updated · ${what}`;
}

/** The Due-next aside: the week the card names, extended with how far the SELECTED rows reach when they run past it. */
export function dueNextWindowLabel(rows: readonly BriefRow[], weekOfLabel: string): string {
  const base = `By next binding date · week of ${weekOfLabel}`;
  const furthest = rows.reduce<BriefRow | null>((best, r) => (r.dueDays == null ? best : best?.dueDays == null || r.dueDays > best.dueDays ? r : best), null);
  return furthest?.dueDays != null && furthest.dueDays >= STATED_WINDOW_DAYS && furthest.due ? `${base}, reaching to ${furthest.due.label}` : base;
}

/** What a card draws: its rows, an honest empty, or a failed read (no rows because we could not look is not "nothing changed"). */
export type BriefCardState = "rows" | "empty" | "failed";
export const briefCardState = (rowCount: number, failed: boolean): BriefCardState => (rowCount > 0 ? "rows" : failed ? "failed" : "empty");

/** The date of the latest change: the newest change date among the rows the card draws, else the newest changelog date, else "" (never today). */
export function computeAuditDate(rows: ReadonlyArray<{ changeDate?: string | null | undefined }>, changelogDate: string | null): string {
  const newest = rows.reduce((best, r) => (r.changeDate && r.changeDate > best ? r.changeDate : best), "");
  return newest || changelogDate || "";
}

