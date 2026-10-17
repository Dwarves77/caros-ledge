// Ported from old_repo/src/lib/research/assess.mjs (lines 1-404)
// Ported from old_repo/src/lib/research/surface-candidate.mjs (lines 1-14)
// Ported from old_repo/scripts/producers/research/research-assessment-producer.mjs (lines 26-288)
// Ported from old_repo/scripts/producers/research/research-assessment-producer.mjs (lines 311-409)
// The producer: the live candidates, the OpenAlex source records, the row writes and the signpost writes. The assessment itself is ./model/assess.
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { entityId } from "@/core/entities";
import { workByDoi, type OpenAlexDeps } from "@/core/http/openalex";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

import { assessItem, extractDoiCandidate, hasChanged, isResearchCandidate, RESEARCH_CANDIDATE_OR, toAssessmentInput, toRow, type AssessInput, type ForwardEvent, type SignpostSpec } from "./model/assess";

/** DOI in the item's text to an OpenAlex work to a source record for the authority score; unresolved is no record, never a guessed one. */
export async function resolveOpenAlexSourceRecords(input: AssessInput, deps: OpenAlexDeps = {}): Promise<Rec[]> {
  const doi = extractDoiCandidate(input.text);
  const work = doi ? await workByDoi(doi, deps) : null;
  if (!doi || !work) return [];
  const inst = ((work.authorships as Array<{ institutions?: Array<{ display_name?: string; type?: string }> }> | undefined)?.[0]?.institutions?.[0]) ?? null;
  const pct = (work.citation_normalized_percentile as { value?: unknown } | undefined)?.value;
  return [{ sourceId: `doi:${doi}`, kind: "openalex", institution: inst ? { displayName: inst.display_name ?? null, type: inst.type ?? null } : null, work: { publicationDate: work.publication_date ?? null, citedByCount: typeof work.cited_by_count === "number" ? work.cited_by_count : null, fwci: typeof work.fwci === "number" ? work.fwci : null, citationNormalizedPercentile: typeof pct === "number" ? pct : null, isRetracted: work.is_retracted === true }, funding: null }];
}

/** The live candidates: verified, non-archived research items with NO current assessment (the first pass never re-scores; `itemIds` names the items to re-score, current assessment or not), at most `limit`, with their source tier and forward events. */
export async function fetchLiveCandidates(sb: Db, limit?: number, opts: { itemIds?: readonly string[] } = {}): Promise<AssessInput[]> {
  const items = await fetchAllRows<Rec>((from, to) => sb.from("intelligence_items").select("id,item_type,domain,added_date,title,what_is_it,why_matters,full_brief,source_id,instrument_entity_id").or(RESEARCH_CANDIDATE_OR).eq("is_archived", false).eq("provenance_status", "verified").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  const only = opts.itemIds ? new Set(opts.itemIds) : null;
  const admitted = items.filter((r) => isResearchCandidate(r.item_type, r.domain) && (!only || only.has(String(r.id))));
  const have = new Set(only ? [] : (await fetchAllByIdChunks(admitted.map((r) => String(r.id)), async (ids) => { const { data, error } = await sb.from("research_assessments_current").select("item_id").in("item_id", ids); if (error) throw new Error(`reading research_assessments_current failed: ${error.message}`); return (data ?? []) as Array<{ item_id: string }>; })).map((r) => r.item_id));
  const needing = admitted.filter((r) => !have.has(String(r.id)));
  const picked = typeof limit === "number" && limit > 0 ? needing.slice(0, limit) : needing;
  const tiers = new Map((await fetchAllByIdChunks(picked.map((r) => String(r.source_id)).filter(Boolean), async (ids) => { const { data, error } = await sb.from("sources").select("id,base_tier").in("id", ids); if (error) throw new Error(`reading sources failed: ${error.message}`); return (data ?? []) as Array<{ id: string; base_tier: number | null }>; })).map((s) => [s.id, s.base_tier] as const));
  const events = await fetchAllByIdChunks(picked.map((r) => String(r.id)), async (ids) => { const { data, error } = await sb.from("item_forward_events").select("id,intelligence_item_id,event_date,event_kind,obligation_text").in("intelligence_item_id", ids); if (error) throw new Error(`reading item_forward_events failed: ${error.message}`); return (data ?? []) as Array<Rec>; }, { manyPerId: true });
  const byItem = new Map<string, ForwardEvent[]>();
  for (const e of events) byItem.set(String(e.intelligence_item_id), [...(byItem.get(String(e.intelligence_item_id)) ?? []), { id: String(e.id), kind: e.event_kind as string, event_date: e.event_date as string | null, obligation_text: e.obligation_text as string | null, source_citation: null }]);
  return picked.map((r) => toAssessmentInput({ ...r, source_base_tier: tiers.get(String(r.source_id)) ?? null, forward_events: byItem.get(String(r.id)) ?? [] }));
}

const unwrap = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
  return r.data as T;
};

export const researchAssessment: ProducerSpec = {
  name: "research-assessment",
  table: "research_assessments",
  licenceKey: null,
  enabled: false,
  enabledRuling: "operator 2026-10-04: no data population before every build layer is complete (ADR-023)",
  killSwitchEnv: "RESEARCH_ASSESSMENT_PRODUCER_ENABLED",
  gap: "no assessment candidates: pass candidate inputs, or run with a database client to read the live research items",
  /** The document is the JSON array of assessment inputs; with a client and no injected input the live candidates are read (bounded by input.limit). */
  async fetchDoc(ctx: ProducerCtx) {
    return { text: ctx.sb ? JSON.stringify(await fetchLiveCandidates(ctx.sb, ctx.input.limit)) : "" };
  },
  async parse(doc, ctx): Promise<ParseOut<Rec>> {
    const inputs = JSON.parse(doc.text ?? "[]") as AssessInput[];
    const rows: Rec[] = [];
    const signposts: Record<string, SignpostSpec[]> = {};
    const oa: OpenAlexDeps = { fetch: ctx.deps.fetch as never, ...(ctx.deps.sleep ? { sleep: ctx.deps.sleep } : {}) };
    for (const input of inputs) {
      const records = await resolveOpenAlexSourceRecords(input, oa);
      const computed = assessItem(records.length ? { ...input, sourceRecords: records } : input, { now: ctx.now() });
      rows.push(toRow(computed));
      signposts[input.id] = computed.signposts;
    }
    ctx.state.signposts = signposts;
    return { rows, warnings: [], counts: { candidates: inputs.length } };
  },
  /** Apply: write only changed assessments (flip the superseded row first, restore it if the insert fails), re-point its unscored signposts, then write the deterministic signposts. */
  async persist(ctx, rows) {
    const sb = ctx.sb as Db;
    const ids = rows.map((r) => String(r.item_id));
    const current = new Map((await fetchAllByIdChunks(ids, async (chunkIds) => unwrap(await sb.from("research_assessments_current").select("*").in("item_id", chunkIds), "reading research_assessments_current") as Rec[])).map((r) => [String(r.item_id), r]));
    const signposts = ctx.state.signposts as Record<string, SignpostSpec[]>;
    const c = { unchanged: 0, written: 0, signposts_repointed: 0, signposts_written: 0, signposts_existing: 0, signposts_skipped_no_assessment_id: 0 };
    const planned: Array<{ sp: SignpostSpec; assessmentId: string | null }> = [];
    for (const row of rows) {
      const itemId = String(row.item_id);
      const cur = current.get(itemId) ?? null;
      if (!hasChanged(cur, row)) {
        c.unchanged += 1;
        for (const sp of signposts[itemId] ?? []) planned.push({ sp, assessmentId: cur ? String(cur.id) : null });
        continue;
      }
      if (cur) unwrap(await sb.from("research_assessments").update({ is_current: false }).eq("id", cur.id), "flipping the superseded assessment");
      const ins = await sb.from("research_assessments").insert({ ...row, supersedes: cur ? cur.id : null } as never).select("id").single();
      if (ins.error || !ins.data) {
        if (cur) await sb.from("research_assessments").update({ is_current: true }).eq("id", cur.id);
        throw new Error(`insert of the assessment for ${itemId} failed: ${ins.error?.message ?? "no row returned"}`);
      }
      const newId = (ins.data as { id: string }).id;
      c.written += 1;
      if (cur) {
        const rp = await sb.from("signposts").update({ assessment_id: newId }).eq("assessment_id", cur.id).is("outcome", null).select("entity_id");
        c.signposts_repointed += (unwrap(rp, "re-pointing signposts") ?? []).length;
      }
      for (const sp of signposts[itemId] ?? []) planned.push({ sp, assessmentId: newId });
    }
    const unique = new Map<string, { sp: SignpostSpec; assessmentId: string | null }>();
    for (const p of planned) if (!unique.has(entityId("signpost", p.sp.seed))) unique.set(entityId("signpost", p.sp.seed), p);
    const existing = new Set((await fetchAllByIdChunks([...unique.keys()], async (chunkIds) => unwrap(await sb.from("signposts").select("entity_id").in("entity_id", chunkIds), "reading signposts") as Array<{ entity_id: string }>)).map((r) => r.entity_id));
    for (const [id, p] of unique) {
      if (existing.has(id)) { c.signposts_existing += 1; continue; }
      if (!p.assessmentId) { c.signposts_skipped_no_assessment_id += 1; continue; }
      unwrap(await sb.from("entities").upsert({ entity_id: id, kind: "signpost", canonical_name: p.sp.label, status: "active" } as never, { onConflict: "entity_id" }), "writing the signpost entity");
      unwrap(await sb.from("signposts").insert({ entity_id: id, assessment_id: p.assessmentId, watches: p.sp.watches, predicate: p.sp.predicate, direction: p.sp.direction } as never), "writing the signpost");
      c.signposts_written += 1;
    }
    return c;
  },
};
