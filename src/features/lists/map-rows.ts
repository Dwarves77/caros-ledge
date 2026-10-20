// Ported from old_repo/src/lib/supabase-server.ts (lines 985-1180)
// Ported from old_repo/src/lib/supabase-server.ts (lines 1855-1900)
import { isInstrumentMilestone, timelineDateOf } from "@/core/brief/timeline";
import type { Db } from "@/core/db";
import { requirePriority } from "@/core/lists/bands";
import type { Resource } from "@/core/types";
import type { WorkspaceProfile } from "@/core/workspace";

import { attachImpact } from "./impact";

export interface WorkspaceItemRpcRow {
  id: string;
  legacy_id: string | null;
  transport_modes?: string[] | null;
  category?: string | null;
  title: string;
  source_url?: string | null;
  summary?: string | null;
  item_type?: string | null;
  effective_priority?: string | null;
  priority?: string | null;
  added_date: string | null;
  reasoning?: string | null;
  tags?: string[] | null;
  what_is_it?: string | null;
  why_matters?: string | null;
  key_data?: string[] | null;
  full_brief?: string | null;
  domain?: number | null;
  jurisdictions?: string[] | null;
  jurisdiction_iso?: unknown;
  item_grade?: string | null;
  last_regenerated_at?: string | null;
  origin_class?: string | null;
  source_id?: string | null;
  effective_archived?: boolean | null;
  compliance_deadline?: string | null;
  severity?: string | null;
  signal_band?: "price" | "corporate" | "corridor" | null;
  theme?: string | null;
  trajectory_points?: Resource["trajectoryPoints"] | null;
  what_it_changes?: string | null;
  does_not_resolve?: string | null;
  conversion_trigger?: string | null;
  cross_references?: string | null;
  cost_mechanism?: string | null;
  penalty_range?: string | null;
  enforcement_body?: string | null;
  requirement_trajectory?: Resource["requirementTrajectory"] | null;
}

interface TimelineRow {
  item_id: string;
  milestone_date: string | null;
  date_precision: string | null;
  label: string | null;
  is_completed: boolean | null;
  sort_order: number | null;
}
const TIMELINE_CHUNK = 150;

/** The fields every list row reads, from one RPC row. An absent item_type is "uncertain", never a regulation. */
function baseResourceFields(row: WorkspaceItemRpcRow): Resource {
  return {
    id: row.legacy_id || row.id,
    cat: row.transport_modes?.[0] || "global",
    sub: row.category || "",
    title: row.title,
    url: row.source_url || "",
    note: row.summary || "",
    type: row.item_type || "uncertain",
    priority: requirePriority(row.effective_priority || row.priority, `item ${row.id}`),
    added: row.added_date ?? "",
    reasoning: row.reasoning || "",
    tags: row.tags || [],
    whatIsIt: row.what_is_it || "",
    whyMatters: row.why_matters || "",
    keyData: row.key_data || [],
    ...(row.full_brief ? { fullBrief: row.full_brief } : {}),
    ...(row.domain != null ? { domain: row.domain } : {}),
    modes: row.transport_modes || [],
    ...(row.category ? { topic: row.category } : {}),
    ...(row.jurisdictions?.[0] ? { jurisdiction: row.jurisdictions[0] } : {}),
    ...(Array.isArray(row.jurisdiction_iso) ? { jurisdictionIso: row.jurisdiction_iso as string[] } : {}),
    ...(row.item_grade === "record" || row.item_grade === "brief" ? { itemGrade: row.item_grade } : {}),
    ...(row.last_regenerated_at ? { lastRegeneratedAt: row.last_regenerated_at } : {}),
    ...(row.origin_class ? { originClass: row.origin_class } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    isArchived: row.effective_archived || false,
  };
}

/** The category RPCs' superset columns (severity, signal band, theme, trajectory, the fact-document summary fields). */
export function categoryResourceFields(row: WorkspaceItemRpcRow): Resource {
  return {
    ...baseResourceFields(row),
    timeline: [],
    ...(row.severity ? { severity: row.severity } : {}),
    ...(row.signal_band ? { signalBand: row.signal_band } : {}),
    ...(row.theme ? { theme: row.theme } : {}),
    ...(row.trajectory_points ? { trajectoryPoints: row.trajectory_points } : {}),
    ...(row.what_it_changes ? { whatItChanges: row.what_it_changes } : {}),
    ...(row.does_not_resolve ? { doesNotResolve: row.does_not_resolve } : {}),
    ...(row.conversion_trigger ? { conversionTrigger: row.conversion_trigger } : {}),
    ...(row.cross_references ? { crossReferences: row.cross_references } : {}),
    ...(row.cost_mechanism ? { costMechanism: row.cost_mechanism } : {}),
    ...(row.penalty_range ? { penaltyRange: row.penalty_range } : {}),
    ...(row.enforcement_body ? { enforcementBody: row.enforcement_body } : {}),
    ...(row.requirement_trajectory ? { requirementTrajectory: row.requirement_trajectory } : {}),
  };
}

export interface MappedRows {
  active: Resource[];
  archived: Resource[];
  uuidToUiId: Map<string, string>;
  /** Chunks of item ids whose timeline read failed: those items carry NO timeline, and the caller is told (never silently empty). */
  timelineFailures: number;
}

/** RPC rows to Resources with their timelines, read in chunks of 150 ids; a failed chunk is counted, not hidden. Every row gets its impact (stored scores plus the reading workspace's client score when `orgId` is given) or the sentence of the input it waits for. */
export async function mapRows(db: Db, items: WorkspaceItemRpcRow[], opts: { orgId?: string | null; profile?: WorkspaceProfile | null | undefined } = {}): Promise<MappedRows> {
  const uuidToUiId = new Map(items.map((i) => [i.id, i.legacy_id || i.id]));
  const byItem = new Map<string, TimelineRow[]>();
  let timelineFailures = 0;
  const ids = items.map((i) => i.id);
  for (let i = 0; i < ids.length; i += TIMELINE_CHUNK) {
    try {
      const { data, error } = await db.from("item_timelines").select("item_id, milestone_date, date_precision, label, is_completed, sort_order").in("item_id", ids.slice(i, i + TIMELINE_CHUNK));
      if (error) throw new Error(error.message);
      for (const t of (data ?? []) as TimelineRow[]) byItem.set(t.item_id, [...(byItem.get(t.item_id) ?? []), t]);
    } catch {
      timelineFailures += 1;
    }
  }
  const active: Resource[] = [];
  const archived: Resource[] = [];
  for (const row of items) {
    const timeline = (byItem.get(row.id) ?? []).filter((t) => isInstrumentMilestone(t.sort_order)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((t) => ({ date: timelineDateOf(t.milestone_date ?? "", t.date_precision), label: t.label ?? "", ...(t.is_completed ? { status: "past" as const } : {}) }));
    const resource: Resource = { ...baseResourceFields(row), timeline, ...(row.compliance_deadline ? { complianceDeadline: row.compliance_deadline } : {}) };
    (resource.isArchived ? archived : active).push(resource);
  }
  await attachImpact(db, [...active, ...archived], new Map([...uuidToUiId].map(([uuid, uiId]) => [uiId, uuid])), opts.orgId ?? null, opts.profile);
  return { active, archived, uuidToUiId, timelineFailures };
}

