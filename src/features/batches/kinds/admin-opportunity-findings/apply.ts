// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt), DIGEST-1 D1/D5 for the admin kind (HOW-TO-LOOK point 5): one sourced finding per derived pattern, validated against the pattern's PACKET (an id outside the packet is refused, INV-CN2-4; a quoted span is verbatim in
// the row that offers it), the no-single-source test (rows from at least two tables and two surfaces, INV-DIG-7), the second reader's binary judges, then written to admin_opportunity_findings behind the platform-admin gate (INV-DIG-8: RLS in migration 0122 admits no customer read, the
// apply writes as service_role). Each signpost is registered as an inference record (the falsifiable thing to watch) and the finding keeps its id; a new finding for a pattern supersedes the one before it.
import { rowsByIds } from "@/core/db";
import { packetReader } from "@/core/digest/packets-client";
import { registerInferenceRecord } from "@/core/propagation";

import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type EntrySpec } from "../../kit/session-batch";

import { validateAdminFindingEntry, type AdminLive, type AdminPlan } from "./validate";

const spec: EntrySpec<AdminLive, AdminPlan> = {
  kind: "admin-opportunity-findings",
  batchRe: /^admin-opportunity-findings-[A-Za-z0-9._-]+$/,
  ceiling: 100,
  keyOf: (e) => (typeof e.pattern_value_id === "string" ? e.pattern_value_id : null),
  async load(deps, file) {
    const ids = [...new Set((file.entries as unknown[]).flatMap((x) => (isObj(x) && typeof x.pattern_value_id === "string" ? [x.pattern_value_id] : [])))];
    const read = await (deps.packets ?? packetReader(deps.sb))(ids);
    const current = await rowsByIds<{ id: string; pattern_value_id: string; title: string; sourced_finding_md: string; superseded_by: string | null }>(deps.sb, "admin_opportunity_findings", "id, pattern_value_id, title, sourced_finding_md, superseded_by", ids, "pattern_value_id", "id");
    return { packets: new Map(read.packets.filter((p) => ids.includes(p.id)).map((p) => [p.id, p])), current: new Map(current.filter((c) => !c.superseded_by).map((c) => [c.pattern_value_id, c])) };
  },
  entry(e, i, live) {
    const r = validateAdminFindingEntry(e, i, live);
    return r.plan || r.errors.length || r.residue?.length ? { errors: r.errors, ...(r.residue ? { residue: r.residue } : {}), ...(r.plan ? { plan: r.plan } : {}) } : { errors: [], done: true };
  },
  async write(deps, _live, item, batch) {
    const { entry: e, packet } = item.plan;
    const ids: string[] = [];
    for (const s of e.signposts as { claim_text: string; falsification_condition: string; by: string }[]) {
      if (!item.plan.items.length) throw new Error("a signpost cites at least one item of the packet, and the packet's cited rows name none");
      ids.push(await registerInferenceRecord(deps.sb, { subjectId: null, claimText: `${s.claim_text} (falsified if: ${s.falsification_condition}; by ${s.by})`, statusToken: "HYPOTHESIS", confidence: 0.5, citedItemIds: item.plan.items, originClass: "derived", methodId: "admin-opportunity-finding", methodVersion: "v1", computedBy: `admin-opportunity-findings:${batch}`, inputs: item.plan.items.map((pk) => ({ table: "intelligence_items", pk })) }));
    }
    const row = { lens: e.lens, window: e.window, pattern_value_id: packet.id, title: e.title, sourced_finding_md: e.sourced_finding_md, inferences: e.inferences ?? [], signpost_inference_ids: ids, claim_provenance: e.claim_provenance ?? [], review_score: item.plan.score, review_reasons: item.plan.reasons };
    const ins = await deps.sb.from("admin_opportunity_findings").insert(row).select("id");
    const id = (ins.data as { id: string }[] | null)?.[0]?.id;
    if (ins.error || !id) throw new Error(`admin_opportunity_findings insert failed: ${ins.error?.message ?? "no id returned"}`);
    const sup = await deps.sb.from("admin_opportunity_findings").update({ superseded_by: id }).eq("pattern_value_id", packet.id).is("superseded_by", null).neq("id", id);
    if (sup.error) throw new Error(`the earlier finding was not superseded: ${sup.error.message}`);
    const rv = await deps.sb.from("brief_reviews").upsert({ kind: "admin-opportunity-findings", subject_id: id, batch, score: item.plan.score, reasons: item.plan.reasons, residue: false, reviewed_by: item.plan.reviewer }, { onConflict: "kind,subject_id,batch" });
    if (rv.error) throw new Error(`brief_reviews write failed: ${rv.error.message}`);
    return { ref: packet.id, counts: { findings_written: 1, signposts_registered: ids.length } };
  },
  async readBack(deps, _live, written) {
    const rows = await rowsByIds<{ pattern_value_id: string; superseded_by: string | null; signpost_inference_ids: string[] }>(deps.sb, "admin_opportunity_findings", "id, pattern_value_id, superseded_by, signpost_inference_ids", written.map((w) => w.ref), "pattern_value_id", "id");
    return written.filter((w) => !rows.some((r) => r.pattern_value_id === w.ref && !r.superseded_by && r.signpost_inference_ids.length > 0)).map((w) => w.ref);
  },
};

/** Apply one admin-opportunity-findings batch. */
export const applyAdminFindings = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(spec, deps, file, o);
