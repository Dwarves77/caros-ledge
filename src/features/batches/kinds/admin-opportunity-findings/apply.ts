// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt), DIGEST-1 D1/D5 for the admin kind (HOW-TO-LOOK point 5): one sourced finding per derived pattern, validated against the pattern's PACKET (an id outside the packet is refused, INV-CN2-4; a quoted span is verbatim in
// the row that offers it), the no-single-source test (rows from at least two tables and two surfaces, INV-DIG-7), the second reader's binary judges, then written to admin_opportunity_findings behind the platform-admin gate (INV-DIG-8: RLS in migration 0122 admits no customer read, the
// apply writes as service_role). Each signpost is registered as an inference record (the falsifiable thing to watch) and the finding keeps its id; a new finding for a pattern supersedes the one before it.
import { isVerbatim } from "@/core/contracts/verbatim";
import { rowsByIds } from "@/core/db";
import { LENSES, WINDOWS } from "@/core/digest/kinds";
import { readPackets, type Packet } from "@/core/digest/packets-client";
import { review, singleSourceReason } from "@/core/digest/review";
import { registerInferenceRecord } from "@/core/propagation";

import { applyEntries, isObj, nonEmpty, type ApplyOpts, type BatchDeps, type EntrySpec, type Obj } from "../../kit/session-batch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CITATION = /\[([a-z_]+:[^\]\s]+)\]/g;
const TOKENS = ["CONFIRMED", "HYPOTHESIS", "REFUTED"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
interface AdminLive { packets: Map<string, Packet>; current: Map<string, { id: string; title: string; sourced_finding_md: string }> }
interface AdminPlan { packet: Packet; entry: Obj; items: string[]; score: number; reasons: string; reviewer: string }

/** One entry against its pattern's packet: the refusals (a malformed or out-of-packet value) and the residue (the single-source test, the second reader). */
export function validateAdminFindingEntry(e: unknown, i: number, live: AdminLive): { errors: string[]; residue?: string[]; plan?: AdminPlan } {
  if (!isObj(e)) return { errors: [`entries[${i}]: must be an object`] };
  const tag = `pattern ${String(e.pattern_value_id)}`;
  const errors: string[] = [];
  const at = (m: string) => void errors.push(`${tag}: ${m}`);
  if (typeof e.pattern_value_id !== "string" || !UUID.test(e.pattern_value_id)) return { errors: [`${tag}: pattern_value_id must be a UUID`] };
  const packet = live.packets.get(e.pattern_value_id);
  if (!packet) return { errors: [`${tag}: no packet for this pattern (packets: PENDING CONNECT-2 PR B, or the pattern is not exported); a finding cites nothing outside its packet`] };
  const rows = new Map(packet.members.map((m) => [`${m.table}:${m.id}`, m]));
  if (!(LENSES as readonly unknown[]).includes(e.lens)) at(`lens must be one of ${LENSES.join(", ")}`);
  if (!(WINDOWS as readonly unknown[]).includes(e.window)) at(`window must be one of ${WINDOWS.join(", ")}`);
  if (!nonEmpty(e.title) || e.title.length > 160) at("title must be 1 to 160 characters");
  const finding = typeof e.sourced_finding_md === "string" ? e.sourced_finding_md : "";
  if (!finding.trim()) at("sourced_finding_md must be non-empty");
  const cited = new Set<string>();
  for (const m of finding.matchAll(CITATION)) { const id = m[1] as string; if (rows.has(id)) cited.add(id); else at(`cites ${id}, which is not a row of the packet`); }
  if (finding.trim() && !cited.size) at("the sourced finding cites no packet row ([table:id])");
  (Array.isArray(e.inferences) ? e.inferences : []).forEach((x, k) => {
    if (!isObj(x) || !nonEmpty(x.text) || !TOKENS.includes(x.status_token as string) || !Array.isArray(x.basis) || !x.basis.length) return at(`inferences[${k}] must be { text, status_token (${TOKENS.join(", ")}), basis: [packet rows] }`);
    for (const b of x.basis) if (typeof b !== "string" || !rows.has(b)) at(`inferences[${k}] basis ${JSON.stringify(b)} is not a row of the packet`); else cited.add(b);
  });
  const signposts = Array.isArray(e.signposts) ? e.signposts : [];
  if (!signposts.length) at("a finding carries at least one falsifiable signpost");
  signposts.forEach((s, k) => { if (!isObj(s) || !nonEmpty(s.claim_text) || !nonEmpty(s.falsification_condition) || typeof s.by !== "string" || !ISO.test(s.by)) at(`signposts[${k}] must be { claim_text, falsification_condition, by (ISO date) }`); });
  (Array.isArray(e.claim_provenance) ? e.claim_provenance : []).forEach((c, k) => {
    const m = isObj(c) && typeof c.row === "string" ? rows.get(c.row) : undefined;
    if (!isObj(c) || !m) return at(`claim_provenance[${k}] row ${JSON.stringify(isObj(c) ? c.row : c)} is not a row of the packet`);
    if (!isVerbatim(m.text, typeof c.span === "string" ? c.span : "")) at(`claim_provenance[${k}] span is not verbatim in the packet row ${String(c.row)}`); else cited.add(String(c.row));
  });
  if (errors.length) return { errors };
  const why = [...[singleSourceReason([...cited].map((id) => ({ table: (rows.get(id) as { table: string }).table, surface: rows.get(id)?.surface ?? null })))].flatMap((r) => r ?? []), ...review("admin-opportunity-findings", e).reasons.map((r) => `second reader: ${r}`)];
  if (why.length) return { errors: [], residue: why.map((r) => `${tag}: ${r}`) };
  const rv = review("admin-opportunity-findings", e);
  const prior = live.current.get(e.pattern_value_id);
  if (prior && prior.title === e.title && prior.sourced_finding_md === finding) return { errors: [] };
  const items = [...new Set([...cited].flatMap((id) => rows.get(id)?.item_id ?? (rows.get(id)?.table === "intelligence_items" ? [rows.get(id)?.id as string] : [])))];
  return { errors: [], plan: { packet, entry: e, items, score: rv.score, reasons: "every required judge passed", reviewer: rv.reviewed_by ?? "none" } };
}

const spec: EntrySpec<AdminLive, AdminPlan> = {
  kind: "admin-opportunity-findings",
  batchRe: /^admin-opportunity-findings-[A-Za-z0-9._-]+$/,
  ceiling: 100,
  keyOf: (e) => (typeof e.pattern_value_id === "string" ? e.pattern_value_id : null),
  async load(deps, file) {
    const ids = [...new Set((file.entries as unknown[]).flatMap((x) => (isObj(x) && typeof x.pattern_value_id === "string" ? [x.pattern_value_id] : [])))];
    const read = await (deps.packets ?? readPackets)(ids);
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
