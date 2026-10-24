// Ported from old_repo/src/lib/supabase-server.ts (lines 271-575)
import { allRows } from "@/core/db/reads";
import type { Db } from "@/core/db";
import type { IntelligenceDomain, ProvisionalSource, SourceStatus, SourceTier } from "@/core/sources/types";

/** The statuses of the provisional review queue, named once (COUNTS-61): the queue, its badge and the attention count read the same two. */
const PROVISIONAL_REVIEW_STATUSES = ["pending_review", "needs_more_data"] as const;

/** A registry row as the admin surfaces hold it. A column the database leaves empty stays null: a score never read is "not scored", never a number made up (rule 2). */
export interface AdminSource {
  id: string;
  name: string;
  url: string;
  description: string;
  base_tier: SourceTier;
  effective_tier: SourceTier | null;
  tier_override: SourceTier | null;
  override_reason: string | null;
  tier_at_creation: SourceTier | null;
  domains: IntelligenceDomain[];
  jurisdictions: string[];
  transport_modes: string[];
  update_frequency: string | null;
  last_checked: string | null;
  last_accessible: string | null;
  last_inaccessible: string | null;
  next_scheduled_check: string | null;
  status: SourceStatus;
  paywalled: boolean;
  access_method: string | null;
  processing_paused: boolean;
  admin_only: boolean;
  notes: string;
  created_at: string;
  trust: { overall: number | null; accuracy: number | null; timeliness: number | null; reliability: number | null; citation: number | null; computed_at: string | null };
  metrics: { confirmation_count: number | null; conflict_count: number | null; accuracy_rate: number | null; accessibility_rate: number | null; total_checks: number | null; successful_checks: number | null; independent_citers: number | null; total_citations: number | null; lead_time_days: number | null };
}

export type SourceQueryRow = Record<string, unknown>;
/** PostgREST serialises Postgres numeric as a string: read it as a number, or null when the column is empty or not a number. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const SOURCE_COLUMNS = [
  "id", "name", "url", "description", "base_tier", "effective_tier", "tier_override", "override_reason", "tier_at_creation", "domains", "jurisdictions", "transport_modes", "update_frequency", "last_checked", "last_accessible", "last_inaccessible",
  "next_scheduled_check", "status", "paywalled", "access_method", "processing_paused", "admin_only", "confirmation_count", "conflict_count", "accuracy_rate", "avg_lead_time_days", "accessibility_rate", "total_checks", "successful_checks",
  "independent_citers", "total_citations", "trust_score_overall", "trust_score_accuracy", "trust_score_timeliness", "trust_score_reliability", "trust_score_citation", "trust_score_computed_at", "notes", "created_at",
].join(", ");

/** One query row to the admin shape. Pure: nothing is defaulted that the database did not say. */
export function mapSourceRow(row: SourceQueryRow): AdminSource {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    url: String(row.url ?? ""),
    description: str(row.description) ?? "",
    base_tier: row.base_tier as SourceTier,
    effective_tier: (num(row.effective_tier) as SourceTier | null) ?? null,
    tier_override: (num(row.tier_override) as SourceTier | null) ?? null,
    override_reason: str(row.override_reason),
    tier_at_creation: (num(row.tier_at_creation) as SourceTier | null) ?? null,
    domains: arr<IntelligenceDomain>(row.domains),
    jurisdictions: arr<string>(row.jurisdictions),
    transport_modes: arr<string>(row.transport_modes),
    update_frequency: str(row.update_frequency),
    last_checked: str(row.last_checked),
    last_accessible: str(row.last_accessible),
    last_inaccessible: str(row.last_inaccessible),
    next_scheduled_check: str(row.next_scheduled_check),
    status: (str(row.status) ?? "active") as SourceStatus,
    paywalled: row.paywalled === true,
    access_method: str(row.access_method),
    processing_paused: row.processing_paused === true,
    admin_only: row.admin_only === true,
    notes: str(row.notes) ?? "",
    created_at: String(row.created_at ?? ""),
    trust: { overall: num(row.trust_score_overall), accuracy: num(row.trust_score_accuracy), timeliness: num(row.trust_score_timeliness), reliability: num(row.trust_score_reliability), citation: num(row.trust_score_citation), computed_at: str(row.trust_score_computed_at) },
    metrics: { confirmation_count: num(row.confirmation_count), conflict_count: num(row.conflict_count), accuracy_rate: num(row.accuracy_rate), accessibility_rate: num(row.accessibility_rate), total_checks: num(row.total_checks), successful_checks: num(row.successful_checks), independent_citers: num(row.independent_citers), total_citations: num(row.total_citations), lead_time_days: num(row.avg_lead_time_days) },
  };
}

/** Every registry row, admin-only ones included (profiles and the registry are read on the service client behind the admin gate, SEC-8). A failed read throws: the registry never renders as empty because it could not be read. */
export async function readSources(db: Db): Promise<AdminSource[]> {
  return (await allRows<SourceQueryRow>(db, "sources", SOURCE_COLUMNS, { order: "id" })).map(mapSourceRow).sort((a, b) => a.base_tier - b.base_tier || a.name.localeCompare(b.name));
}

const PROVISIONAL_COLUMNS = "id, name, url, domain, description, discovered_via, provisional_tier, recommended_tier, status, reviewer_notes, created_at, reviewed_at, independent_citers, citation_count, recommended_classification";
export type AdminProvisional = ProvisionalSource & { citation_count: number | null; independent_citers: number | null; bias_tags: unknown };

/** The provisional review queue: the population the badge counts, most independently cited first. */
export async function readProvisional(db: Db): Promise<AdminProvisional[]> {
  const rows = await allRows<SourceQueryRow>(db, "provisional_sources", PROVISIONAL_COLUMNS, { where: (q) => q.in("status", [...PROVISIONAL_REVIEW_STATUSES]) });
  return rows
    .map((r) => ({
      id: String(r.id), name: String(r.name ?? ""), url: String(r.url ?? ""), domain: (num(r.domain) as IntelligenceDomain | null) ?? null, description: str(r.description) ?? "", discovered_via: r.discovered_via as ProvisionalSource["discovered_via"],
      provisional_tier: (num(r.provisional_tier) ?? 7) as SourceTier, recommended_tier: (num(r.recommended_tier) as SourceTier | null) ?? null, status: r.status as ProvisionalSource["status"], reviewer_notes: str(r.reviewer_notes) ?? "",
      created_at: String(r.created_at ?? ""), reviewed_at: str(r.reviewed_at), citation_count: num(r.citation_count), independent_citers: num(r.independent_citers), bias_tags: (r.recommended_classification as { bias_tags?: unknown } | null)?.bias_tags ?? null,
    }))
    .sort((a, b) => (b.independent_citers ?? 0) - (a.independent_citers ?? 0) || a.created_at.localeCompare(b.created_at));
}
