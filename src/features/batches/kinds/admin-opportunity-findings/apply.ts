// New in ENGINE-UNBLOCK-1 lane C (scripts/ci/new-files/engine-unblock-1c.txt), operator rulings 2026-10-26: the admin kind applies a CLUSTER synthesis. Each valid entry writes, in this order: its pattern rows (derived_values under method pattern_ai_<angle>, method_version reader-synthesis@1.0.0, the
// cited rows as evidence edges carrying the reasoning link and quote of each; a pattern of the same cluster and angle it replaces is superseded), its signposts and tagged inferences (inference records), its findings (admin_opportunity_findings behind the platform-admin gate, INV-DIG-8: RLS in
// migration 0122 admits no customer read, the apply writes as service_role; an earlier finding of a replaced pattern is superseded), then the shared write-back: coverage gaps queued for the hunt and new connections. Every write is idempotent on its identity (a re-apply writes nothing new).
import { allRows, rowsByIds } from "@/core/db";
import { registerDerivedValue, type InputRef } from "@/core/propagation";
import { assembleClusters, type Cluster } from "@/core/flywheel/clusters";

import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type EntrySpec } from "../../kit/session-batch";
import { activeEntityIds, connectionEntityIds, heldWriteback, itemIdsOfRows, registerOnce, writeWriteback } from "../../kit/writeback";

import type { AssembleClusters } from "./export";
import { clusterOfComputedBy, findingKey, METHOD_VERSION, methodIdOf, SYNTHESIS_PREFIX, validateSynthesisEntry, type SynthLive, type SynthPlan } from "./validate";

const KIND = "admin-opportunity-findings";
const SPENT = ["superseded", "obsolete", "falsified"];
const splitKey = (k: string): InputRef => ({ table: k.slice(0, k.indexOf(":")), pk: k.slice(k.indexOf(":") + 1) });
/** The clusters a batch may name, re-assembled from the stored records now: an entry is applied only against the graph as it stands. */
const assemble = (deps: BatchDeps): AssembleClusters => deps.assembleClusters ?? assembleClusters;

interface DetectorRow { value_id: string; method_id: string; lifecycle: string; admissibility: string; inputs: { table?: string; pk?: string }[] | null }

const spec: EntrySpec<SynthLive, SynthPlan> = {
  kind: KIND,
  batchRe: /^admin-opportunity-findings-[A-Za-z0-9._-]+$/,
  ceiling: 100,
  keyOf: (e) => (typeof e.cluster_id === "string" ? e.cluster_id : null),
  async load(deps, file) {
    const entries = (file.entries as unknown[]).filter(isObj);
    const ids = new Set(entries.flatMap((x) => (typeof x.cluster_id === "string" ? [x.cluster_id] : [])));
    const { clusters } = await assemble(deps)(deps.sb, { limit: 5000, minSurfaces: 2 });
    const mine: Cluster[] = clusters.filter((c) => ids.has(c.id));
    const captureIds = [...new Set(mine.flatMap((c) => c.rows.flatMap((r) => r.quote_capture_id ?? [])))];
    const captures = new Map((await rowsByIds<{ id: string; result_content: string | null }>(deps.sb, "agent_run_searches", "id, result_content", captureIds, "id", "id")).map((c) => [c.id, c.result_content ?? ""]));
    const entityRefs = entries.flatMap((x) => [...connectionEntityIds(x), ...(Array.isArray(x.patterns) ? x.patterns : []).flatMap((p) => (isObj(p) && Array.isArray(p.entity_ids) ? p.entity_ids : []))]).filter((v): v is string => typeof v === "string");
    const entities = await activeEntityIds(deps.sb, entityRefs);
    const detectorRows = (await allRows<DetectorRow>(deps.sb, "derived_values", "value_id, method_id, lifecycle, admissibility, inputs", { order: "value_id", where: (q) => q.like("method_id", "pattern_%").is("invalidated_at", null) })).filter((r) => !r.method_id.startsWith("pattern_ai_") && !SPENT.includes(r.lifecycle) && r.admissibility !== "stale");
    const detectors = new Map(mine.map((c) => { const keys = new Set(c.rows.map((r) => `${r.table}/${r.pk}`)); return [c.id, detectorRows.filter((d) => (d.inputs ?? []).some((i) => keys.has(`${i.table}/${i.pk}`))).map((d) => d.value_id)] as const; }));
    const items = new Map<string, string[]>();
    const patterns = new Map<string, string>();
    for (const c of mine) {
      items.set(c.id, await itemIdsOfRows(deps.sb, c.rows));
      for (const p of await allRows<{ value_id: string; computed_by: string; lifecycle: string; admissibility: string }>(deps.sb, "derived_values", "value_id, computed_by, lifecycle, admissibility", { order: "value_id", where: (q) => q.like("computed_by", `${SYNTHESIS_PREFIX}${c.id}:%`).is("invalidated_at", null) })) if (clusterOfComputedBy(p.computed_by) === c.id && !SPENT.includes(p.lifecycle) && p.admissibility !== "stale") patterns.set(p.computed_by, p.value_id);
    }
    const found = await rowsByIds<{ pattern_value_id: string; title: string; sourced_finding_md: string; superseded_by: string | null }>(deps.sb, "admin_opportunity_findings", "id, pattern_value_id, title, sourced_finding_md, superseded_by", [...patterns.values()], "pattern_value_id", "id");
    const findings = new Set(found.filter((f) => !f.superseded_by).map((f) => findingKey(f.pattern_value_id, f.title, f.sourced_finding_md)));
    return { clusters: new Map(mine.map((c) => [c.id, c])), captures, entities, detectors, items, stored: { patterns, findings }, held: await heldWriteback(deps.sb, KIND, entries), now: deps.now(), locate: deps.locate ?? null };
  },
  entry(e, i, live) {
    const r = validateSynthesisEntry(e, i, live);
    return r.plan || r.errors.length || r.residue?.length || r.done ? { errors: r.errors, ...(r.residue ? { residue: r.residue } : {}), ...(r.plan ? { plan: r.plan } : {}), ...(r.done ? { done: true } : {}) } : { errors: [], done: true };
  },
  async write(deps, live, item, batch) {
    const { plan } = item;
    const sb = deps.sb;
    const counts: Record<string, number> = { patterns_written: 0, findings_written: 0, tagged_inferences_registered: 0 };
    const valueOf = new Map<string, string>();
    const replaced = new Map<string, string[]>();
    for (const p of plan.patterns) {
      const have = live.stored.patterns.get(p.computedBy);
      if (have) { valueOf.set(p.ref, have); continue; }
      const prior = (await allRows<{ value_id: string; computed_by: string; lifecycle: string; admissibility: string }>(sb, "derived_values", "value_id, computed_by, lifecycle, admissibility", { order: "value_id", where: (q) => q.like("computed_by", `${SYNTHESIS_PREFIX}${plan.cluster.id}:${p.angle}:%`).is("invalidated_at", null) })).filter((r) => !SPENT.includes(r.lifecycle) && clusterOfComputedBy(r.computed_by) === plan.cluster.id);
      const id = await registerDerivedValue(sb, { entityId: p.entityId, methodId: methodIdOf(p.angle), methodVersion: METHOD_VERSION, derivation: "assessed", originClass: "derived", lifecycle: "emerging", admissibility: "analysis_ok", confidence: 0.5, assertedAt: deps.now().toISOString(), inputs: p.inputs, computedBy: p.computedBy, supersedes: prior[0]?.value_id ?? null });
      if (prior.length) {
        const sup = await sb.from("derived_values").update({ lifecycle: "superseded" }).in("value_id", prior.map((r) => r.value_id));
        if (sup.error) throw new Error(`the earlier pattern was not superseded: ${sup.error.message}`);
        replaced.set(id, prior.map((r) => r.value_id));
      }
      valueOf.set(p.ref, id);
      counts["patterns_written"] = (counts["patterns_written"] ?? 0) + 1;
    }
    const inputs = plan.cited.map(splitKey);
    const wb1 = await writeWriteback(deps, { signposts: plan.wb.signposts, gaps: [], connections: [] }, { kind: KIND, batch, subject: plan.cluster.id, findingId: null, citedItemIds: plan.items, inputs });
    for (const t of plan.tagged) {
      await registerOnce(sb, { subjectId: null, claimText: t.text, statusToken: t.statusToken, confidence: 0.5, citedItemIds: plan.items, originClass: "derived", methodId: "admin-opportunity-finding", methodVersion: "v1", computedBy: `${KIND}:${batch}`, inputs: t.basis.map(splitKey) });
      counts["tagged_inferences_registered"] = (counts["tagged_inferences_registered"] ?? 0) + 1;
    }
    let firstFinding: string | null = null;
    const newByPattern = new Map<string, string[]>();
    for (const f of plan.findings) {
      const pvid = f.patternValueId ?? (valueOf.get(f.patternRef as string) as string);
      if (live.stored.findings.has(findingKey(pvid, f.title, f.md))) continue;
      const ins = await sb.from("admin_opportunity_findings").insert({ lens: f.lens, window: f.window, pattern_value_id: pvid, title: f.title, sourced_finding_md: f.md, inferences: f.inferences, signpost_inference_ids: wb1.signpostIds, claim_provenance: f.claimProvenance, review_score: plan.score, review_reasons: plan.reasons }).select("id");
      const id = (ins.data as { id: string }[] | null)?.[0]?.id;
      if (ins.error || !id) throw new Error(`admin_opportunity_findings insert failed: ${ins.error?.message ?? "no id returned"}`);
      firstFinding ??= id;
      newByPattern.set(pvid, [...(newByPattern.get(pvid) ?? []), id]);
      const rv = await sb.from("brief_reviews").upsert({ kind: KIND, subject_id: id, batch, score: plan.score, reasons: plan.reasons, residue: false, reviewed_by: plan.reviewer }, { onConflict: "kind,subject_id,batch" });
      if (rv.error) throw new Error(`brief_reviews write failed: ${rv.error.message}`);
      counts["findings_written"] = (counts["findings_written"] ?? 0) + 1;
    }
    for (const [pvid, fresh] of newByPattern) {
      const older = [pvid, ...(replaced.get(pvid) ?? [])];
      for (const old of older) {
        const sup = await sb.from("admin_opportunity_findings").update({ superseded_by: fresh[0] }).eq("pattern_value_id", old).is("superseded_by", null).not("id", "in", `(${fresh.join(",")})`);
        if (sup.error) throw new Error(`the earlier finding was not superseded: ${sup.error.message}`);
      }
    }
    const wb2 = await writeWriteback(deps, { signposts: [], gaps: plan.wb.gaps, connections: plan.wb.connections }, { kind: KIND, batch, subject: plan.cluster.id, findingId: firstFinding, citedItemIds: plan.items, inputs });
    for (const [k, n] of [...Object.entries(wb1.counts), ...Object.entries(wb2.counts)]) counts[k] = (counts[k] ?? 0) + n;
    return { ref: plan.cluster.id, counts, notes: wb2.notes };
  },
  async readBack(deps, _live, written) {
    const bad: string[] = [];
    for (const w of written) {
      const stored = new Map((await allRows<{ value_id: string; computed_by: string }>(deps.sb, "derived_values", "value_id, computed_by", { order: "value_id", where: (q) => q.like("computed_by", `${SYNTHESIS_PREFIX}${w.ref}:%`) })).filter((r) => clusterOfComputedBy(r.computed_by) === w.ref).map((r) => [r.computed_by, r.value_id]));
      const current = new Set((await rowsByIds<{ pattern_value_id: string; superseded_by: string | null }>(deps.sb, "admin_opportunity_findings", "id, pattern_value_id, superseded_by", [...stored.values()], "pattern_value_id", "id")).filter((f) => !f.superseded_by).map((f) => f.pattern_value_id));
      const lost = w.plan.patterns.some((p) => !stored.has(p.computedBy)) || w.plan.findings.some((f) => !f.patternValueId && !current.has(stored.get(w.plan.patterns.find((p) => p.ref === f.patternRef)?.computedBy ?? "") ?? ""));
      if (lost) bad.push(w.ref);
    }
    return bad;
  },
};

/** Apply one admin-opportunity-findings batch. */
export const applyAdminFindings = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(spec, deps, file, o);
