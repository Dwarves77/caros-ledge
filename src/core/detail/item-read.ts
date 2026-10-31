// Ported from old_repo/src/lib/supabase-server.ts (lines 3776-4234)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2043-2072)
// The one read of an item for its detail page: explicit columns, the verified and non-archived gate (INV-125), ONE uuid resolution (the old tree resolved the same id six ways), bounded
// relationship reads, the sections by uuid, and the mapper for every field the four detail surfaces render (including the columns the old mapper never read: recommended actions, the
// instrument identifier and the last-verified date). The reader is the caller's client: RLS decides what is visible, a failed read throws (never "not found", never an empty block).
import { admitItems } from "@/core/derived/admissible";
import { CANDIDATE_ORIGIN, evidenceOf } from "@/core/flywheel/discover";
import { isInstrumentMilestone, timelineDateOf } from "@/core/brief/timeline";
import type { Db } from "@/core/db";
import { boundedRead } from "@/core/db/query";
import { normalizeJurisdictionIsoColumn } from "@/core/jurisdictions";
import { canonicalSurface, requirePriority, type DetailSurface } from "@/core/lists";
import { surfaceOf } from "@/core/routing";
import { customerTierOf } from "@/core/sources";
import type { RelevanceInput } from "@/core/workspace";
import type { ChangeLogEntry, Dispute, ItemConnection, Resource, Supersession } from "@/core/types";
import type { RecommendedAction } from "@/core/brief";

import { itemIdColumn } from "./id-redirect";

const ITEM_COLUMNS =
  "id, legacy_id, title, summary, what_is_it, why_matters, key_data, tags, domain, category, item_type, source_id, source_url, jurisdictions, transport_modes, priority, reasoning, added_date, is_archived, full_brief, " +
  "last_regenerated_at, jurisdiction_iso, agent_integrity_flag, agent_integrity_phrase, agent_integrity_flagged_at, agent_integrity_resolved_at, topic_tags, operational_scenario_tags, compliance_object_tags, " +
  "origin_class, item_grade, severity, signal_band, theme, trajectory_points, what_it_changes, does_not_resolve, conversion_trigger, compliance_deadline, cost_mechanism, penalty_range, enforcement_body, " +
  "requirement_trajectory, recommended_actions, instrument_identifier, last_verified, intersection_summary, sources(name, base_tier, effective_tier, tier_override)";
const BOUND = { timelines: 200, changelog: 20, crossRefs: 200, supersessions: 50, sections: 100, cited: 100 } as const;

export interface SectionRow {
  id: string;
  section_key: string;
  section_order: number;
  content_md: string;
  is_conditional: boolean;
  [k: string]: unknown;
}
export interface DetailRead {
  /** The item's uuid: every later read takes this, none resolves the URL id again. */
  uuid: string;
  resource: Resource;
  sections: SectionRow[];
  changelog: ChangeLogEntry[];
  dispute: Dispute | null;
  supersessions: Supersession[];
  connections: ItemConnection[];
  /** The extractor's shape (action_text, verb, timeframe_days, owner, due_date, source_section), read as it was written. */
  recommendedActions: RecommendedAction[];
  intersectionSummary: string | null;
  relevanceInput: RelevanceInput;
  canonicalSurface: DetailSurface;
}

type Embedded = { id: string; legacy_id: string | null; item_type?: string | null; domain?: number | null };
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const uiIdOf = (e: Embedded | Embedded[] | null | undefined): string | null => {
  const x = one(e);
  return x ? x.legacy_id || x.id : null;
};

async function bounded<T>(what: string, limit: number, build: (n: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string | null } | null }>): Promise<T[]> {
  const r = await boundedRead(build, { limit });
  if (r.error) throw new Error(`${what} read failed: ${r.error.message}`);
  return r.data;
}

/** The sources a brief cites, each with its customer tier and bias tags; undefined when it cites none the reader can see. A failed read throws. */
async function readCitedSources(db: Db, itemUuid: string): Promise<Resource["citedSources"]> {
  type Src = { id: string; url: string | null; base_tier: number | null; effective_tier: number | null; tier_override: number | null };
  const rows = await bounded<{ source: Src | Src[] | null }>("intelligence_item_citations", BOUND.cited, (n) => db.from("intelligence_item_citations").select("source:sources(id, url, base_tier, effective_tier, tier_override)").eq("intelligence_item_id", itemUuid).limit(n) as never);
  const bySource = new Map<string, Src>();
  for (const r of rows) {
    const s = one(r.source);
    if (s && typeof s.url === "string" && s.url) bySource.set(s.id, s);
  }
  if (bySource.size === 0) return undefined;
  const bias = await bounded<{ source_id: string; dimension: string; tag: string; confidence: number | null }>("source_bias_tags", 200, (n) => db.from("source_bias_tags").select("source_id, dimension, tag, confidence").in("source_id", [...bySource.keys()]).limit(n) as never);
  return [...bySource.values()].map((s) => ({
    url: s.url as string,
    tier: customerTierOf(s),
    biasTags: bias.filter((b) => b.source_id === s.id && (b.dimension === "funding" || b.dimension === "methodology" || b.dimension === "stakeholder")).map((b) => ({ dimension: b.dimension as "funding" | "methodology" | "stakeholder", tag: String(b.tag), confidence: typeof b.confidence === "number" ? b.confidence : null })),
  }));
}

/** One item for its detail page, or null when no verified, non-archived item the reader can see has this id. */
export async function readDetailItem(db: Db, urlId: string): Promise<DetailRead | null> {
  const { data: row, error } = await admitItems(db.from("intelligence_items").select(ITEM_COLUMNS)).eq(itemIdColumn(urlId), urlId).maybeSingle();
  if (error) throw new Error(`intelligence_items read failed: ${error.message}`);
  if (!row) return null;
  const r = row as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a PostgREST row under an explicit column list
  const uuid: string = r.id;
  const resourceId: string = r.legacy_id || uuid;
  const src = one<{ name: string | null; base_tier: number | null; effective_tier: number | null; tier_override: number | null }>(r.sources);

  const [timelines, changes, disputes, xrefs, sups, bias, cited, sections] = await Promise.all([
    bounded<{ milestone_date: string | null; date_precision: string | null; label: string | null; is_completed: boolean | null; sort_order: number | null }>("item_timelines", BOUND.timelines, (n) => db.from("item_timelines").select("milestone_date, date_precision, label, is_completed, sort_order").eq("item_id", uuid).order("sort_order", { ascending: true }).limit(n) as never),
    bounded<{ change_date: string; change_type: "NEW" | "UPDATED"; field: string | null; previous_value: string | null; new_value: string | null; impact: string | null }>("item_changelog", BOUND.changelog, (n) => db.from("item_changelog").select("change_date, change_type, field, previous_value, new_value, impact").eq("item_id", uuid).order("change_date", { ascending: false }).limit(n) as never),
    bounded<{ note: string; disputing_sources: unknown }>("item_disputes", 1, (n) => db.from("item_disputes").select("note, disputing_sources").eq("item_id", uuid).eq("is_active", true).limit(n) as never),
    bounded<{ source_item_id: string; target_item_id: string; relationship: string | null; origin: string | null; basis: ItemConnection["basis"]; score: number | null; source: Embedded | Embedded[] | null; target: Embedded | Embedded[] | null }>(
      "item_cross_references",
      BOUND.crossRefs,
      (n) => db.from("item_cross_references").select("source_item_id, target_item_id, relationship, origin, basis, score, source:intelligence_items!source_item_id(id, legacy_id, item_type, domain), target:intelligence_items!target_item_id(id, legacy_id, item_type, domain)").or(`source_item_id.eq.${uuid},target_item_id.eq.${uuid}`).neq("origin", CANDIDATE_ORIGIN).limit(n) as never,
    ),
    bounded<{ supersession_date: string; severity: string; note: string | null; old: Embedded | Embedded[] | null; new: Embedded | Embedded[] | null }>(
      "item_supersessions",
      BOUND.supersessions,
      (n) => db.from("item_supersessions").select("supersession_date, severity, note, old:intelligence_items!old_item_id(id, legacy_id), new:intelligence_items!new_item_id(id, legacy_id)").or(`old_item_id.eq.${uuid},new_item_id.eq.${uuid}`).limit(n) as never,
    ),
    r.source_id ? bounded<{ dimension: string; tag: string; confidence: number | null }>("source_bias_tags", 100, (n) => db.from("source_bias_tags").select("dimension, tag, confidence").eq("source_id", r.source_id).limit(n) as never) : Promise.resolve([]),
    readCitedSources(db, uuid),
    bounded<SectionRow>("intelligence_item_sections", BOUND.sections, (n) => db.from("intelligence_item_sections").select("id, section_key, section_order, content_md, is_conditional").eq("item_id", uuid).order("section_order", { ascending: true }).limit(n) as never),
  ]);

  const biasTags = bias.filter((b) => b.dimension === "funding" || b.dimension === "methodology" || b.dimension === "stakeholder").map((b) => ({ dimension: b.dimension as "funding" | "methodology" | "stakeholder", tag: String(b.tag), confidence: typeof b.confidence === "number" ? b.confidence : null }));
  const iso = normalizeJurisdictionIsoColumn(r.jurisdiction_iso);
  const tier = src ? customerTierOf(src) : null;
  const resource: Resource = {
    id: resourceId,
    itemUuid: uuid,
    cat: r.transport_modes?.[0] || "global",
    sub: r.category || "",
    title: r.title,
    url: r.source_url || "",
    note: r.summary || "",
    type: r.item_type || "uncertain",
    priority: requirePriority(r.priority, `item ${uuid}`),
    added: r.added_date ?? "",
    reasoning: r.reasoning || "",
    tags: r.tags || [],
    whatIsIt: r.what_is_it || "",
    whyMatters: r.why_matters || "",
    keyData: r.key_data || [],
    timeline: timelines.filter((t) => isInstrumentMilestone(t.sort_order)).map((t) => ({ date: timelineDateOf(t.milestone_date ?? "", t.date_precision), label: t.label ?? "", ...(t.is_completed ? { status: "past" as const } : {}) })),
    modes: r.transport_modes || [],
    isArchived: r.is_archived === true,
    ...(r.full_brief ? { fullBrief: r.full_brief } : {}),
    ...(r.domain != null ? { domain: r.domain } : {}),
    ...(r.category ? { topic: r.category } : {}),
    ...(r.jurisdictions?.[0] ? { jurisdiction: r.jurisdictions[0] } : {}),
    ...(iso ? { jurisdictionIso: iso } : {}),
    ...(r.item_grade === "record" || r.item_grade === "brief" ? { itemGrade: r.item_grade } : {}),
    ...(r.last_regenerated_at ? { lastRegeneratedAt: r.last_regenerated_at } : {}),
    ...(r.origin_class ? { originClass: r.origin_class } : {}),
    ...(r.source_id ? { sourceId: r.source_id } : {}),
    ...(src?.name ? { sourceName: src.name } : {}),
    ...(tier !== null ? { sourceTier: tier } : {}),
    ...(biasTags.length > 0 ? { biasTags } : {}),
    ...(cited && cited.length > 0 ? { citedSources: cited } : {}),
    ...(r.severity ? { severity: r.severity } : {}),
    ...(r.signal_band ? { signalBand: r.signal_band } : {}),
    ...(r.theme ? { theme: r.theme } : {}),
    ...(r.trajectory_points ? { trajectoryPoints: r.trajectory_points } : {}),
    ...(r.conversion_trigger ? { conversionTrigger: r.conversion_trigger } : {}),
    ...(r.what_it_changes ? { whatItChanges: r.what_it_changes } : {}), ...(Array.isArray(r.compliance_object_tags) && r.compliance_object_tags.length > 0 ? { complianceObjectTags: r.compliance_object_tags } : {}), ...(Array.isArray(r.operational_scenario_tags) && r.operational_scenario_tags.length > 0 ? { operationalScenarioTags: r.operational_scenario_tags } : {}),
    ...(r.does_not_resolve ? { doesNotResolve: r.does_not_resolve } : {}),
    ...(r.compliance_deadline ? { complianceDeadline: r.compliance_deadline } : {}),
    ...(r.cost_mechanism ? { costMechanism: r.cost_mechanism } : {}),
    ...(r.penalty_range ? { penaltyRange: r.penalty_range } : {}),
    ...(r.enforcement_body ? { enforcementBody: r.enforcement_body } : {}),
    ...(r.requirement_trajectory ? { requirementTrajectory: r.requirement_trajectory } : {}),
    ...(r.instrument_identifier ? { legalInstrument: r.instrument_identifier } : {}),
    ...(r.last_verified ? { lastVerifiedDate: r.last_verified } : {}),
    agentIntegrityFlag: r.agent_integrity_flag === true && !r.agent_integrity_resolved_at,
    agentIntegrityPhrase: r.agent_integrity_phrase || null,
    agentIntegrityFlaggedAt: r.agent_integrity_flagged_at || null,
  };

  const dispute = disputes[0];
  const sources = dispute ? (Array.isArray(dispute.disputing_sources) ? dispute.disputing_sources : []) : [];
  const connections: ItemConnection[] = [];
  for (const x of xrefs) {
    const outgoing = x.source_item_id === uuid;
    const other = outgoing ? x.target : x.source;
    const otherId = uiIdOf(other);
    const o = one(other);
    if (!otherId || !o) continue;
    connections.push({ id: otherId, direction: outgoing ? "outgoing" : "incoming", relationship: x.relationship || "related", origin: x.origin || "manual", basis: evidenceOf(x.basis) as ItemConnection["basis"], score: typeof x.score === "number" ? x.score : null, surface: surfaceOf(o.item_type ?? undefined, o.domain ?? undefined) });
  }
  const supersessions: Supersession[] = sups.flatMap((s) => {
    const oldId = uiIdOf(s.old);
    const newId = uiIdOf(s.new);
    return oldId && newId ? [{ old: oldId, new: newId, date: s.supersession_date, severity: s.severity as Supersession["severity"], note: s.note || "" }] : [];
  });
  const summary = typeof r.intersection_summary === "string" && r.intersection_summary.trim() ? r.intersection_summary.trim() : null;
  return {
    uuid,
    resource,
    sections,
    changelog: changes.map((c) => ({ id: resourceId, date: c.change_date, type: c.change_type, ...(c.field ? { fields: [c.field] } : {}), ...(c.previous_value ? { prev: c.previous_value } : {}), ...(c.new_value ? { now: c.new_value } : {}), ...(c.impact ? { impact: c.impact } : {}) })),
    dispute: dispute ? { resource: resourceId, note: dispute.note, sources: sources.map((s: unknown) => (typeof s === "string" ? { name: s, url: "" } : (s as { name: string; url: string }))) } : null,
    supersessions,
    connections,
    recommendedActions: Array.isArray(r.recommended_actions) ? (r.recommended_actions as RecommendedAction[]) : [],
    intersectionSummary: summary,
    relevanceInput: { title: r.title ?? null, transport_modes: r.transport_modes ?? null, jurisdictions: r.jurisdictions ?? null, jurisdiction_iso: r.jurisdiction_iso ?? null, topic_tags: r.topic_tags ?? null, operational_scenario_tags: r.operational_scenario_tags ?? null, compliance_object_tags: r.compliance_object_tags ?? null },
    canonicalSurface: canonicalSurface({ type: r.item_type ?? null, domain: r.domain ?? null }),
  };
}
