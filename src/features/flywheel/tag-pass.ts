// Ported from old_repo/scripts/connections/propose-tags.mjs (lines 28-120)
// Ported from old_repo/scripts/connections/propose-tags.mjs (lines 187-420)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 444-575)
// The tag pass (ADR-025, no human gate, no two-step queue): for each target item derive tags by rule from its own grounded text, drop the ones an admin
// removed, decide each (high adopts; medium adopts with vocabulary and evidence re-confirmed), write the merged tag columns, record the decision as a flag
// born resolved, then run connection discovery for every item whose tags changed (rule 17: new tags are new connections).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { SIGNATURE_CAP } from "@/core/flywheel/signature";
import type { RunResult } from "@/core/sources/run-result";
import { adoptTags, type AdoptResult, type TaggedItem } from "@/core/tags/adopt";
import { assembleTagInput, deriveTags } from "@/core/tags/derive";
import { readAdoptedVocabulary } from "@/core/vocabulary/adopted";
import type { Correction } from "@/features/corrections/model";

import { runConnectionDiscovery } from "./run-discovery";

export interface TagPassDeps {
  sb: Db;
  now: () => Date;
}
export interface TagPassInput {
  /** Exactly one selector: ids, since (created at or after), or untagged (every item whose three tag fields are empty). */
  ids?: readonly string[];
  since?: string;
  untagged?: boolean;
  dry: boolean;
  /** Run discovery for items whose tags changed (default true). The connect step passes false because it runs discovery itself. */
  discover?: boolean;
}
const ITEM_COLUMNS = "id, title, canonical_instrument_key, jurisdiction_iso, jurisdictions, full_brief, what_is_it, summary, operational_scenario_tags, compliance_object_tags, topic_tags, created_at";
type Row = TaggedItem & { jurisdiction_iso?: string[] | null; jurisdictions?: string[] | null; created_at?: string | null };

const isEmptySignature = (it: Row): boolean => ![it.operational_scenario_tags, it.compliance_object_tags, it.topic_tags].some((a) => Array.isArray(a) && a.length > 0);

async function readByItem<T extends { [k: string]: unknown }>(sb: Db, table: string, columns: string, idColumn: string, ids: readonly string[]): Promise<Map<string, T[]>> {
  const rows = await fetchAllByIdChunks<T>(ids, async (slice) => {
    const { data, error } = await sb.from(table).select(columns).in(idColumn, slice);
    if (error) throw new Error(`tag pass: ${table} read failed: ${error.message}`);
    return (data ?? []) as unknown as T[];
  }, { manyPerId: true });
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(String(r[idColumn]), [...(out.get(String(r[idColumn])) ?? []), r]);
  return out;
}

/** The tag pass over its selection. Per-item write failures are counted and noted (outcome partial), never swallowed. */
export async function tagPass(deps: TagPassDeps, input: TagPassInput): Promise<RunResult<{ results: AdoptResult[] }>> {
  const { sb } = deps;
  const selectors = [input.ids?.length ? 1 : 0, input.since ? 1 : 0, input.untagged ? 1 : 0].reduce((a, b) => a + b, 0);
  if (selectors !== 1) return { counts: {}, outcome: "failed", notes: ["pass exactly one of ids, since, untagged"], data: { results: [] } };
  if (input.since && Number.isNaN(Date.parse(input.since))) return { counts: {}, outcome: "failed", notes: [`since is not a parseable date: ${JSON.stringify(input.since)}`], data: { results: [] } };
  const corpus = await fetchAllRows<Row>((from, to) => sb.from("intelligence_items").select(ITEM_COLUMNS).eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: SIGNATURE_CAP });
  const wanted = input.ids ? new Set(input.ids) : null;
  const sinceMs = input.since ? Date.parse(input.since) : 0;
  const targets = corpus.filter((it) => (wanted ? wanted.has(it.id) : input.since ? !!it.created_at && Date.parse(it.created_at) >= sinceMs : isEmptySignature(it)));
  const notes: string[] = [];
  const missing = wanted ? [...wanted].filter((id) => !targets.some((t) => t.id === id)) : [];
  if (missing.length) notes.push(`${missing.length} requested id(s) not in the verified live corpus (ignored): ${missing.join(", ")}`);
  const counts: Record<string, number> = { corpus: corpus.length, targets: targets.length, with_proposals: 0, adopted: 0, declined: 0, items_written: 0, blocked_by_correction: 0, flags_written: 0, failed: 0, discovery_written: 0 };
  if (!targets.length) return { counts, outcome: "ok", notes, data: { results: [] } };

  const ids = targets.map((t) => t.id);
  const [sections, claims, searches, corrections] = await Promise.all([
    readByItem<{ item_id: string; content_md: string | null }>(sb, "intelligence_item_sections", "item_id, content_md", "item_id", ids),
    readByItem<{ intelligence_item_id: string; claim_kind: string; claim_text: string | null }>(sb, "section_claim_provenance", "intelligence_item_id, claim_kind, claim_text", "intelligence_item_id", ids),
    readByItem<{ intelligence_item_id: string; result_content: string | null }>(sb, "agent_run_searches", "intelligence_item_id, result_content", "intelligence_item_id", ids),
    readByItem<Correction & { [k: string]: unknown }>(sb, "item_corrections", "*", "item_id", ids),
  ]);
  const { adopted, note } = await readAdoptedVocabulary(sb);
  if (note) notes.push(note);

  const results: AdoptResult[] = [];
  const touched: string[] = [];
  for (const item of targets) {
    const wide = assembleTagInput({ ...item, sections: sections.get(item.id) ?? [], claims: claims.get(item.id) ?? [], searchResults: searches.get(item.id) ?? [] }, { adopted });
    const derived = deriveTags(wide, adopted);
    const r = await adoptTags(sb, item, derived.proposals, { now: deps.now(), adopted, dry: input.dry, corrections: (corrections.get(item.id) ?? []) as Correction[] });
    results.push(r);
    if (derived.proposals.length) counts.with_proposals = (counts.with_proposals ?? 0) + 1;
    counts.adopted = (counts.adopted ?? 0) + r.decisions.filter((d) => d.decision === "adopt").length;
    counts.declined = (counts.declined ?? 0) + r.decisions.filter((d) => d.decision === "decline").length;
    counts.blocked_by_correction = (counts.blocked_by_correction ?? 0) + r.blockedByCorrection;
    if (r.wrote) {
      counts.items_written = (counts.items_written ?? 0) + 1;
      touched.push(item.id);
    }
    if (r.flagWritten) counts.flags_written = (counts.flags_written ?? 0) + 1;
    if (r.notes.length) {
      counts.failed = (counts.failed ?? 0) + 1;
      notes.push(...r.notes);
    }
  }
  if (!input.dry && input.discover !== false) {
    for (const id of touched) {
      try {
        const d = await runConnectionDiscovery({ sb }, id);
        counts.discovery_written = (counts.discovery_written ?? 0) + (d.write?.written ?? 0);
        if (d.write?.failedChunks) {
          counts.failed = (counts.failed ?? 0) + 1;
          notes.push(...d.write.notes);
        }
      } catch (e) {
        counts.failed = (counts.failed ?? 0) + 1;
        notes.push(`discovery after tags failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { counts, outcome: counts.failed ? "partial" : "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes, data: { results } };
}
