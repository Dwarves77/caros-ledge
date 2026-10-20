// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 136-194)
// Ported from old_repo/src/components/admin/redesign/AdminIssuesRail.tsx (lines 43-252)
// Ported from old_repo/src/components/admin/redesign/FlagsRejectionsQueue.tsx (lines 39-162)
// Ported from old_repo/src/app/admin/factors/page.tsx (lines 61-120)
// The console's pure arithmetic: what each tile, tab, badge and rail row counts. No React, so a test imports it.
import type { AttentionCounts } from "../api/attention";

import type { FactorRow } from "./FactorsPage";

export interface SectionDef {
  name: string;
  sub: string;
  tabs: string[];
}
export const SECTIONS: readonly SectionDef[] = [
  { name: "Workspaces", sub: "Organizations, members, invitations, per-tenant overrides.", tabs: ["Organizations"] },
  { name: "Sources", sub: "Registry, bulk add, provisional review, tier classification.", tabs: ["Provisional review", "Source registry", "Bulk add", "Tier disagreements", "Spot-check"] },
  { name: "Ingest", sub: "Staged updates, flags and rejections, dispatch.", tabs: ["Flags & rejections", "Staged updates", "Dispatch", "Statutory rows", "Corrections"] },
  { name: "Coverage", sub: "Jurisdiction review, coverage matrix, gap analysis.", tabs: ["Jurisdiction review", "Coverage matrix", "Catalogue"] },
  { name: "Research pipeline", sub: "Machine-gated items and their status.", tabs: ["Pipeline"] },
  { name: "Runtime", sub: "First-party error tracking, assumption register, inferences, the record of privileged acts.", tabs: ["Errors", "Assumptions", "Inferences", "Admin events"] },
];

export type Counts = { held: number; factors: number; disagreements: number; harnessRuns: number; errors: number };

/** The number on a section tile, from a read that succeeded: null when the read failed (the tile then says so; a tile never invents a zero). Pure. */
export function tileCount(name: string, d: { orgs: number | null; attention: AttentionCounts | null; counts: Counts | null }): number | null {
  const a = d.attention;
  if (name === "Workspaces") return d.orgs;
  if (name === "Sources") return a ? a.provisional_sources_pending : null;
  if (name === "Ingest") return a ? a.staged_updates_pending + a.integrity_flags_unresolved + a.platform_integrity_flags_open + (a.ingest_rejections_untriaged ?? 0) : null;
  if (name === "Coverage") return a ? a.coverage_gaps_critical : null;
  if (name === "Research pipeline") return d.counts ? d.counts.held : null;
  return d.counts ? d.counts.errors : null;
}
/** The count on a sub-tab, or null so the tab renders bare (a tab with no live count never shows a fabricated zero). Pure. */
export function subTabCount(label: string, d: { attention: AttentionCounts | null; sources: number | null; disagreements: number | null }): number | null {
  const a = d.attention;
  const pos = (n: number | null | undefined) => (typeof n === "number" && n > 0 ? n : null);
  if (label === "Provisional review") return pos(a?.provisional_sources_pending);
  if (label === "Spot-check") return pos(a?.auto_approved_awaiting_spotcheck);
  if (label === "Flags & rejections") return a ? pos(a.integrity_flags_unresolved + a.platform_integrity_flags_open + (a.ingest_rejections_untriaged ?? 0)) : null;
  if (label === "Source registry") return pos(d.sources);
  if (label === "Tier disagreements") return pos(d.disagreements);
  return null;
}

export interface IssueNavTarget {
  section: string;
  tab: string;
}
export interface IssueRow {
  key: string;
  title: string;
  count: number;
  target: IssueNavTarget;
}

/** The queue rows in the artboard's own order (a count that changes must not reorder the list under the operator's eye). Pure. */
export function issueRows(c: AttentionCounts): IssueRow[] {
  const rows: IssueRow[] = [
    { key: "provisional", title: "Provisional sources pending review", count: c.provisional_sources_pending, target: { section: "Sources", tab: "Provisional review" } },
    { key: "platform", title: "Platform integrity flags open", count: c.platform_integrity_flags_open, target: { section: "Ingest", tab: "Flags & rejections" } },
    { key: "spotcheck", title: "Auto-approved awaiting spot-check", count: c.auto_approved_awaiting_spotcheck, target: { section: "Sources", tab: "Spot-check" } },
    { key: "integrity", title: "Integrity flags unresolved", count: c.integrity_flags_unresolved, target: { section: "Ingest", tab: "Flags & rejections" } },
    { key: "rejections", title: "Ingest rejections untriaged", count: c.ingest_rejections_untriaged ?? Number.NaN, target: { section: "Ingest", tab: "Flags & rejections" } },
    { key: "staged", title: "Staged updates pending", count: c.staged_updates_pending, target: { section: "Ingest", tab: "Staged updates" } },
    { key: "materialization", title: "Materialization failures", count: c.staged_updates_materialization_failed, target: { section: "Ingest", tab: "Staged updates" } },
    { key: "attribution", title: "Source attribution mismatches", count: c.source_attribution_mismatches, target: { section: "Sources", tab: "Source registry" } },
    { key: "coverage", title: "Coverage gaps (critical)", count: c.coverage_gaps_critical, target: { section: "Coverage", tab: "Jurisdiction review" } },
  ];
  // A count the database does not report yet is not a row: it is neither zero nor part of the total.
  return rows.filter((r) => Number.isFinite(r.count));
}

/** The total is the sum of the rows drawn below it, never a separate scalar that could contradict them (INV-281). */
export const issueTotal = (rows: readonly IssueRow[]): number => rows.reduce((t, r) => t + r.count, 0);

export type Kind = "integrity" | "platform" | "rejections";

/** The three kinds and the badge of each: the same attention counts the rail and the tab read, so a badge cannot contradict its list (INV-281). A count that has not been read renders bare. Pure. */
export function flagKinds(c: Pick<AttentionCounts, "integrity_flags_unresolved" | "platform_integrity_flags_open" | "ingest_rejections_untriaged"> | null) {
  return [
    { key: "integrity" as Kind, label: "Integrity · per-brief", count: c?.integrity_flags_unresolved ?? null },
    { key: "platform" as Kind, label: "Platform · data quality", count: c?.platform_integrity_flags_open ?? null },
    { key: "rejections" as Kind, label: "Rejections · unparseable", count: c?.ingest_rejections_untriaged ?? null },
  ];
}

/** What a factor is, in one line. Pure. */
export const kindLabel = (f: Pick<FactorRow, "mode" | "vehicle_class" | "energy_carrier" | "jurisdiction" | "operator_key" | "corridor_id">): string => [f.mode, f.vehicle_class, f.energy_carrier, f.jurisdiction, f.operator_key ? `operator:${f.operator_key}` : null, f.corridor_id ? `corridor:${f.corridor_id.slice(0, 20)}…` : null].filter(Boolean).join(" · ");
/** Every populated leg: a source may state one, two or all three. A factor with none shows the absence, never a zero. Pure. */
export const valueCell = (f: Pick<FactorRow, "wtt_co2e" | "ttw_co2e" | "wtw_co2e">): string => [f.wtt_co2e !== null ? `WTT ${f.wtt_co2e}` : null, f.ttw_co2e !== null ? `TTW ${f.ttw_co2e}` : null, f.wtw_co2e !== null ? `WTW ${f.wtw_co2e}` : null].filter(Boolean).join(" · ") || "not stated";
