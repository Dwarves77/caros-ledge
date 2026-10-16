// Ported from old_repo/scripts/classification/propose-classifications.mjs (lines 39-302)
// Ported from old_repo/scripts/classification/apply-classifications.mjs (lines 104-133)
// Ported from old_repo/scripts/classification/apply-classifications.mjs (lines 180-371)
// Ported from old_repo/scripts/classification/apply-classifications.mjs (lines 413-480)
// Ported from old_repo/scripts/classification/apply-classifications.mjs (lines 579-623)
// Ported from old_repo/scripts/sources/backfill-source-type.mjs (lines 16-100)
// Ported from old_repo/scripts/source-role-cleanup.mjs (lines 22-59)
import { allRows, fetchAllRows } from "@/core/db";
import { REGULATORY_TOPIC_ROLES, classifySourceAxes, detectDrift, isValidDistribution, isValidJurisdictionValue, observedDistributionFromItems, topicKeywordMatch, type AxisProposal, type AxisSource } from "@/core/sources/axes";
import { classifySourceRole, classifySourceType } from "@/core/sources/classify";
import { outcomeOf, type RunDeps, type RunResult } from "@/core/sources/run-result";

export const AXIS_CREATED_BY = "flywheel-axis:source-classification";
export const DRIFT_CREATED_BY = "flywheel-axis:source-drift";
/** A source's own observed item mix replaces its expected_output only from a sample this large and this wide. */
export const DRIFT_MIN_ITEMS = 20;
export const DRIFT_MIN_DISTINCT_DATES = 2;
const ARRAY_FIELDS = ["jurisdiction_iso", "scope_topics", "scope_modes", "scope_verticals"] as const;

export interface Decision {
  field: string;
  label: string;
  decision: "adopt" | "decline";
  reason: string;
  value?: unknown;
  tag?: string;
}
/** Decide every proposal, expanding scope_topics to one decision per topic (re-confirmed against the source's own name and role now, never trusted from a stale payload). Pure; no residue. */
export function decideProposals(proposals: AxisProposal[], source: AxisSource): Decision[] {
  const out: Decision[] = [];
  for (const p of proposals) {
    const label = `${p.field}=${JSON.stringify(p.value)}`;
    if (p.field === "scope_topics") {
      for (const topic of p.value as string[]) {
        const evidence = topicKeywordMatch(topic, source.name) ?? (topic === "regulatory" && source.source_role && REGULATORY_TOPIC_ROLES.has(source.source_role) ? `source_role=${source.source_role}` : null);
        out.push({ field: p.field, tag: topic, label: `scope_topics:${topic}`, decision: evidence ? "adopt" : "decline", reason: evidence ? `evidence "${evidence}" re-confirmed in the source's own name or role` : `no re-confirmable keyword or role evidence for topic "${topic}"` });
      }
    } else if (p.field === "expected_output") {
      out.push({ field: p.field, value: p.value, label, decision: "adopt", reason: "closed role-to-default lookup, deterministic; adopted when unset" });
    } else if (p.field === "jurisdiction_iso" && (p.value as unknown[]).some((v) => !isValidJurisdictionValue(v))) {
      out.push({ field: p.field, value: p.value, label, decision: "decline", reason: "a jurisdiction_iso value is not in the framework vocabulary" });
    } else {
      const decisive = p.confidence === "high";
      out.push({ field: p.field, value: p.value, label, decision: decisive ? "adopt" : "decline", reason: decisive ? `confidence 'high': a decisive match for ${p.field}` : `confidence '${p.confidence}' does not meet the decisive 'high' bar for ${p.field}` });
    }
  }
  return out;
}

/** The sources UPDATE patch from the adopted decisions. Array fields merge (existing values survive, novel ones append); expected_output sets only when null. Only the five applicable columns can appear. */
export function buildMergePatch(current: AxisSource, decisions: Decision[]): { patch: Record<string, unknown>; applied: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  const applied: Record<string, unknown> = {};
  const adopted = decisions.filter((d) => d.decision === "adopt");
  for (const field of ARRAY_FIELDS) {
    const existing = Array.isArray(current[field]) ? (current[field] as string[]) : [];
    const candidates = adopted.filter((d) => d.field === field).flatMap((d) => (d.tag ? [d.tag] : Array.isArray(d.value) ? (d.value as string[]) : [d.value as string]));
    const novel = [...new Set(candidates.filter((v) => !existing.includes(v)))];
    if (novel.length) {
      patch[field] = [...existing, ...novel];
      applied[field] = novel;
    }
  }
  const eo = adopted.find((d) => d.field === "expected_output");
  if (eo && current.expected_output == null) {
    patch.expected_output = eo.value;
    applied.expected_output = eo.value;
  }
  return { patch, applied };
}

export const countDistinctDates = (items: Array<{ created_at?: string | null }>): number => new Set(items.map((i) => (i.created_at ? String(i.created_at).slice(0, 10) : null)).filter(Boolean)).size;
/** Is the source's own observed item mix a large enough, wide enough sample to become its expected_output? */
export function decideDriftResolution(observed: Record<string, number> | null, items: Array<{ created_at?: string | null }>) {
  const dates = countDistinctDates(items);
  return items.length >= DRIFT_MIN_ITEMS && dates >= DRIFT_MIN_DISTINCT_DATES && isValidDistribution(observed) ? { adopt: true as const, patch: { expected_output: observed } } : { adopt: false as const, patch: null };
}

type SourceRow = AxisSource & { id: string; source_type?: string[] | null; source_role?: string | null };
const COLUMNS = "id, name, url, source_role, source_type, jurisdiction_iso, scope_topics, scope_modes, scope_verticals, expected_output";

export interface ClassifyDeps extends RunDeps {
  /** The item-to-surface classifier (the flywheel's surface-of), injected: this slice owns no item taxonomy. */
  surfaceOf: (itemType: string | null, domain: number | null) => string;
}
/** SQL for a forward data migration from a backfill plan: compare-and-set role updates and NULL-only source_type updates by id, so a re-run never overwrites a changed row. */
export function renderBackfillSql(plan: Array<{ id: string; source_role?: string; from_role?: string | null; source_type?: string[] }>): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return plan
    .flatMap((p) => [p.source_role ? `UPDATE public.sources SET source_role = ${q(p.source_role)} WHERE id = ${q(p.id)} AND source_role IS NOT DISTINCT FROM ${p.from_role ? q(p.from_role) : "NULL"};` : "", p.source_type?.length ? `UPDATE public.sources SET source_type = ARRAY[${p.source_type.map(q).join(", ")}]::text[] WHERE id = ${q(p.id)} AND source_type IS NULL;` : ""])
    .filter(Boolean)
    .join("\n");
}

/**
 * The one deterministic classify-sources job: for every source compute the Axis 3, 4 and 5 proposals, decide each by rule, write the adopted fields through a statement that
 * touches only the five applicable columns, adopt the observed distribution on drift, fill a NULL source_role and source_type once (never overwriting), and record one born-resolved audit
 * row per source changed. No flag round trip, no human token. `dry` computes and writes nothing.
 */
export async function classifySources(deps: ClassifyDeps, input: { dry?: boolean; limit?: number } = {}): Promise<RunResult<{ backfillSql: string }>> {
  const { db } = deps;
  let sources: SourceRow[];
  try {
    sources = await allRows<SourceRow>(db, "sources", COLUMNS);
  } catch (e) {
    return { counts: {}, outcome: "failed", notes: [`sources read failed: ${(e as Error).message}`] };
  }
  if (input.limit) sources = sources.slice(0, input.limit);
  const notes: string[] = [];
  const plan: Array<{ id: string; source_role?: string; from_role?: string | null; source_type?: string[] }> = [];
  let changed = 0;
  let drift = 0;
  let failed = 0;
  const audit = async (id: string, createdBy: string, description: string) => {
    const { error } = await db.from("integrity_flags").insert({ category: "source_issue", subject_type: "source", subject_ref: id, description: description.slice(0, 480), recommended_actions: [], status: "resolved", resolved_at: deps.now().toISOString(), resolved_by: "classify-sources", resolution_note: description.slice(0, 480), created_by: createdBy });
    if (error) notes.push(`${id}: audit row failed: ${error.message}`);
  };
  for (const s of sources) {
    const proposedRole = classifySourceRole(s.name, s.url);
    const role = proposedRole ?? s.source_role ?? null;
    const classified = classifySourceAxes({ ...s, source_role: role });
    const decisions = decideProposals(classified.proposals, { ...s, source_role: role });
    const { patch, applied } = buildMergePatch(s, decisions);
    const backfill: { id: string; source_role?: string; from_role?: string | null; source_type?: string[] } = { id: s.id };
    if (proposedRole && proposedRole !== s.source_role) Object.assign(backfill, { source_role: proposedRole, from_role: s.source_role ?? null });
    const types = s.source_type == null ? classifySourceType({ name: s.name, url: s.url }) : [];
    if (types.length) backfill.source_type = types;
    if (backfill.source_role || backfill.source_type) plan.push(backfill);
    if (input.dry) continue;
    if (Object.keys(patch).length) {
      const { error } = await db.from("sources").update(patch).eq("id", s.id);
      if (error) {
        failed++;
        notes.push(`${s.id}: axis write failed: ${error.message}`);
      } else {
        changed++;
        await audit(s.id, AXIS_CREATED_BY, `classify-sources adopted ${Object.keys(applied).join(", ")}; ${decisions.filter((d) => d.decision === "decline").length} proposal(s) declined with reasons.`);
      }
    }
    for (const [col, value, was] of [["source_role", backfill.source_role, s.source_role ?? null], ["source_type", backfill.source_type, null]] as const) {
      if (value == null) continue;
      // Compare-and-set: the write holds only while the column still has the value read, so a row changed in between is left alone.
      const base = db.from("sources").update({ [col]: value }).eq("id", s.id);
      const { error } = await (was == null ? base.is(col, null) : base.eq(col, was));
      if (error) {
        failed++;
        notes.push(`${s.id}: ${col} write failed: ${error.message}`);
      }
    }
    const expected = patch.expected_output ?? s.expected_output;
    if (expected && isValidDistribution(expected)) {
      let items: Array<{ item_type: string | null; domain: number | null; created_at: string | null }> = [];
      try {
        items = await fetchAllRows((from, to) => db.from("intelligence_items").select("item_type, domain, created_at").eq("source_id", s.id).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 });
      } catch (e) {
        notes.push(`${s.id}: item read failed: ${(e as Error).message}`);
        failed++;
        continue;
      }
      const observed = observedDistributionFromItems(items, deps.surfaceOf);
      if (observed && detectDrift(observed, expected as Record<string, number>).drifted) {
        const d = decideDriftResolution(observed, items);
        if (d.adopt) {
          const { error } = await db.from("sources").update(d.patch).eq("id", s.id);
          if (error) {
            failed++;
            notes.push(`${s.id}: drift write failed: ${error.message}`);
          } else {
            drift++;
            await audit(s.id, DRIFT_CREATED_BY, `drift resolved: expected_output refreshed from ${items.length} item(s) across ${countDistinctDates(items)} distinct date(s).`);
          }
        }
      }
    }
  }
  return { counts: { sources: sources.length, changed, drift_adopted: drift, backfill_planned: plan.length, failed }, outcome: outcomeOf(sources.length, failed), notes, data: { backfillSql: renderBackfillSql(plan) } };
}
