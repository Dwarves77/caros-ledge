// Ported from old_repo/scripts/turns/apply-need-urls.mjs (lines 37-185)
// Ported from old_repo/scripts/connections/ratify-flag-to-census.mjs (lines 95-110)
// Need URLs applied: the source of a session-found URL is registered at the tier the class table (or a host verdict) gives its host, the output the need kind calls for is created (a census row the mint reads, or a portal
// candidate the ledger consume classifies), and the need flag is resolved with a marker the export reads back so the same need is never searched twice. Born would_mint: the mint's own screen, preflight and gates decide;
// a census row with no disposition has no reader in this tree. A below-floor source is rated, never refused (rule 18).
import type { Db } from "@/core/db";
import { registerAndRate } from "@/core/sources";
import { persistPortalCandidates } from "@/features/intake";

import { applyEntries, isObj, rowsByIds, type ApplyOpts, type BatchDeps, type EntrySpec } from "../../kit/session-batch";

import { buildAppliedNote, loadFlagsByIds, loadLineageTargets, needFromFlag, needKindOf, parseAppliedNote, RESOLVED_BY, type FullFlag, type Need } from "./needs";
import { validateNeedEntry, type NeedPlan, type NeedsLive } from "./validate";

const LIVE = ["open", "in_review"];

async function censusRows(sb: Db, sourceId: string, url: string): Promise<{ id: string }[]> {
  const { data, error } = await sb.from("census_worklist").select("id").eq("source_id", sourceId).eq("document_url", url);
  if (error) throw new Error(`census_worklist read failed: ${error.message}`);
  return (data ?? []) as { id: string }[];
}

export const needsSearchSpec: EntrySpec<NeedsLive, NeedPlan> = {
  kind: "needs-search",
  batchRe: /^needs-search-[A-Za-z0-9._-]+$/,
  ceiling: 200,
  keyOf: (e) => (typeof e.need_id === "string" ? e.need_id : null),
  async load(deps, file) {
    const ids = [...new Set((file.entries as unknown[]).map((e) => (isObj(e) && typeof e.need_id === "string" ? e.need_id : "")).filter(Boolean))];
    const flags = await loadFlagsByIds(deps.sb, ids);
    const open = flags.filter((f) => LIVE.includes(f.status) && needKindOf(f.created_by));
    const lineageTargets = await loadLineageTargets(deps.sb, open.filter((f) => needKindOf(f.created_by) === "lineage-gap"));
    const needs = new Map<string, Need>();
    for (const f of open) {
      const r = needFromFlag(f, lineageTargets);
      if ("need" in r) needs.set(f.id, r.need);
    }
    return { needs, flags: new Map(flags.map((f) => [f.id, f])), committed: deps.verdicts ?? null };
  },
  entry: (e, i, live) => validateNeedEntry(e, i, live),
  async write(deps, _live, item, batch) {
    const { need, host, tier, verdicts } = item.plan;
    const url = String(item.entry.url);
    const rated = await registerAndRate(deps.sb, url, { name: null, verdicts });
    if (rated.status !== "registered" && rated.status !== "existing") throw new Error(`rating: ${rated.status === "refused" ? rated.reason : `the host ${host} places in no class (worklist)`}`);
    if (rated.tier !== tier) throw new Error(`rating: the registry places ${host} at T${rated.tier}, the validated plan at T${tier}`);
    const counts: Record<string, number> = rated.status === "registered" ? { sources_registered: 1 } : { sources_existing: 1 };
    let output: string;
    if (need.output === "census_worklist") {
      const have = await censusRows(deps.sb, rated.source_id, url);
      if (have.length) {
        counts.census_rows_existing = 1;
        output = `census_worklist:${have[0]?.id}`;
      } else {
        const ins = await deps.sb.from("census_worklist").insert({ source_id: rated.source_id, document_url: url, lane: "C", created_by: `flywheel-ratified:${need.need_id}`, shape_class: null, surface_tags: [], dryrun_disposition: "would_mint", notes: `needs-search ${batch}: ${String(item.entry.institution)} (ratified from integrity_flags ${need.need_id})` }).select("id").single();
        if (ins.error || !ins.data) throw new Error(`census row: ${ins.error?.message ?? "no row returned"}`);
        counts.census_rows_created = 1;
        output = `census_worklist:${(ins.data as { id: string }).id}`;
      }
    } else {
      const up = await persistPortalCandidates(deps.sb, rated.source_id, [{ url, anchorText: String(item.entry.institution) }], deps.now().toISOString());
      if (up.failed) throw new Error(`portal_link_candidates upsert failed: ${up.notes.join("; ")}`);
      counts.portal_candidates_upserted = 1;
      output = `portal_link_candidates:${url}`;
    }
    const note = buildAppliedNote({ key: need.key, url, sourceId: rated.source_id, tier, kind: need.kind, output, batch });
    const closed = await deps.sb.from("integrity_flags").update({ status: "resolved", resolved_at: deps.now().toISOString(), resolved_by: RESOLVED_BY, resolution_note: note }).eq("id", need.need_id).in("status", LIVE).select("id");
    if (closed.error) throw new Error(`integrity_flags update failed: ${closed.error.message}`);
    counts.flags_resolved = (closed.data ?? []).length;
    return { ref: `${rated.source_id}|${output}`, counts };
  },
  async readBack(deps, _live, written) {
    const flags = new Map((await rowsByIds<FullFlag>(deps.sb, "integrity_flags", "id, subject_ref, created_by, description, recommended_actions, status, created_at, resolved_by, resolution_note", written.map((w) => w.plan.need.need_id))).map((r) => [r.id, r]));
    const sources = new Map((await rowsByIds<{ id: string; status: string }>(deps.sb, "sources", "id, status", written.map((w) => w.ref.split("|")[0] as string))).map((r) => [r.id, r]));
    const bad: string[] = [];
    for (const w of written) {
      const [sourceId] = w.ref.split("|") as [string];
      const f = flags.get(w.plan.need.need_id);
      const url = String(w.entry.url);
      let out: boolean;
      if (w.plan.need.output === "census_worklist") out = (await censusRows(deps.sb, sourceId, url)).length === 1;
      else {
        const r = await deps.sb.from("portal_link_candidates").select("id").eq("url", url);
        if (r.error) throw new Error(`portal_link_candidates read failed: ${r.error.message}`);
        out = (r.data ?? []).length === 1;
      }
      if (!(f && f.status === "resolved" && parseAppliedNote(f.resolution_note)?.key === w.plan.need.key && sources.get(sourceId)?.status === "active" && out)) bad.push(w.plan.need.need_id);
    }
    return bad;
  },
};

export const applyNeedsSearch = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(needsSearchSpec, deps, file, o);
