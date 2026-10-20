// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 756-780)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 864-940)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1062-1177)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1370-1402)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1484-1599)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1621-1640)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 2295-2335)
// The brief pipeline's free path. A SESSION authors the body, the metadata and the claim ledger against the item's stored pool; this module
// validates and writes them. injectBrief is the only way a brief enters (it replaces the metered generate step): it refuses a stale pool
// hash (INV-157), a brief-grade item without the explicit flag, a metadata object that does not satisfy the contract table (INV-159), a
// body that reads as a fetch failure or carries an internal marker, and a body that leaves a required slot silently unaddressed.
// writeSynthesizedBrief is the one write site of a brief. Every runtime entry returns { counts, outcome, notes }; every read and write
// destructures and acts on its error.
import { checkBriefContent, findInternalMarkers, describeMarkers, extractSections, parseNewSources, specForItemType, stripClaimLedgerBlocks } from "@/core/brief/sections";
import { harvestTimeline } from "@/core/brief/timeline";
import { validateClaimRecords, validateMetadata, type BriefMetadata } from "@/core/brief/validate";
import { assertDbValue, bankCandidate, DB_FORMAT_TYPE_VALUES, DB_PRIORITY_VALUES, DB_SIGNAL_BAND_VALUES, DB_URGENCY_TIER_VALUES, toDbSeverity } from "@/core/brief/vocab";
import type { AdoptedTerms } from "@/core/brief/contract";
import { fetchAllRows, type Db } from "@/core/db";
import { groundBrief, poolHash, readPool, readRequiredSlots, uncoveredSlots, type GroundResult } from "@/core/grounding";
import { reconcileSections } from "@/core/grounding/ledger";
import { admissibleRows } from "@/core/derived/admissible";
import { runResult, type RunResult } from "@/core/intake/result";
import { stripUrlMarkers } from "@/core/shared/url";

import type { IntakeDeps } from "./deps";

type Deps = Pick<IntakeDeps, "sb" | "sources" | "recorder">;
const cleanCtl = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The adopted vocabulary terms (status adopted). A failed read is reported and the code vocabularies stand: it never widens what is accepted. */
export async function readAdoptedTerms(sb: Db): Promise<{ adopted: AdoptedTerms; note: string | null }> {
  try {
    const rows = await fetchAllRows<{ kind: string; term_key: string; label: string | null }>((from, to) => sb.from("vocabulary_terms").select("kind, term_key, label").eq("status", "adopted").order("id", { ascending: true }).range(from, to), { cap: 50_000 });
    const out: Record<string, { key: string }[]> = {};
    for (const r of rows) (out[r.kind] ??= []).push({ key: r.term_key });
    return { adopted: out as AdoptedTerms, note: null };
  } catch (e) {
    return { adopted: {}, note: `adopted terms unreadable (${message(e)}); the code vocabularies stand` };
  }
}

/** The research assessment block spliced into a research_finding author context (spec 03S1): only real values, or empty. */
export async function planningAssumptionContext(sb: Db, itemId: string): Promise<{ block: string; note: string | null }> {
  const r = await sb.from("research_assessments_current").select("horizon_band, horizon_kind, horizon_rule, technical_maturity_low, technical_maturity_high, commercial_maturity_low, commercial_maturity_high").eq("item_id", itemId).maybeSingle();
  if (r.error) return { block: "", note: `research_assessments_current read failed: ${r.error.message}` };
  const d = r.data as Record<string, unknown> | null;
  if (!d?.horizon_band) return { block: "", note: null };
  const maturity = (k: string, lo: unknown, hi: unknown) => (lo != null && hi != null ? `, ${k}_low=${lo}, ${k}_high=${hi}` : "");
  return { block: `\n\nRESEARCH ASSESSMENT CONTEXT (cite ONLY these real values in section 3's "Planning assumption shift:" line):\n- Assessment: horizon_band=${d.horizon_band}, horizon_kind=${d.horizon_kind}, horizon_rule=${d.horizon_rule}${maturity("technical_maturity", d.technical_maturity_low, d.technical_maturity_high)}${maturity("commercial_maturity", d.commercial_maturity_low, d.commercial_maturity_high)}`, note: null };
}

export interface InjectInput {
  itemId: string;
  body: string;
  metadata: unknown;
  /** The hash of the pool the author read (poolHash over the usable captures). */
  sourcePoolHash: string;
  allowBriefOverwrite?: boolean;
  dry?: boolean;
}
export type InjectResult = RunResult & { ok: boolean; detail: string; errors: string[]; metadata?: BriefMetadata };

const refused = (detail: string, errors: string[] = [], notes: string[] = []): InjectResult => ({ ...runResult("failed", { refused: 1 }, [detail, ...errors, ...notes]), ok: false, detail, errors });

/**
 * Validate and write a session-authored brief. Order: item, grade guard, stale-pool guard (INV-157), metadata contract (INV-159), body
 * hygiene, required-slot coverage, then THE write site. `dry` runs every check and writes nothing.
 */
export async function injectBrief(deps: Deps, input: InjectInput): Promise<InjectResult> {
  const { sb } = deps;
  try {
    const r = await sb.from("intelligence_items").select("id, title, item_type, source_id, source_url, item_grade").eq("id", input.itemId).maybeSingle();
    if (r.error) return refused(`item read failed: ${r.error.message}`);
    const it = r.data as { id: string; item_type: string; item_grade: string | null } | null;
    if (!it) return refused("item not found");
    if (it.item_grade !== "record" && !input.allowBriefOverwrite) return refused(`refused: item ${input.itemId} is item_grade='${it.item_grade ?? "brief"}', not 'record': pass allowBriefOverwrite to regenerate an existing brief`);
    const pool = await readPool(sb, input.itemId);
    const current = poolHash(pool.map((p) => ({ url: p.url, text: p.text })));
    if (current !== input.sourcePoolHash) return refused(`stale pool: the injected sourcePoolHash (${input.sourcePoolHash}) does not match the current stored pool hash (${current}) for item ${input.itemId}: the author read pool text that no longer matches what is stored`);
    const notes: string[] = [];
    const terms = await readAdoptedTerms(sb);
    if (terms.note) notes.push(terms.note);
    const v = validateMetadata(input.metadata, { adopted: terms.adopted, now: deps.recorder.now() });
    if (!v.ok) return refused(`injected_metadata_invalid: ${v.errors.length} error(s)`, v.errors, notes);
    notes.push(...v.warnings);
    const body = stripClaimLedgerBlocks(stripUrlMarkers(input.body.trim()) ?? "");
    if (body.length < 600) return refused(`parsed body too short (${body.length})`, [], notes);
    const cc = checkBriefContent(body);
    if (!cc.ok) return refused(`brief_failure_gate: ${cc.reason}`, [], notes);
    const markers = findInternalMarkers(body);
    if (markers.length) return refused(`internal_marker_in_body: ${describeMarkers(markers)}`, [], notes);
    const slots = await readRequiredSlots(sb, it.item_type);
    const missing = uncoveredSlots(body, slots);
    if (missing.length) return refused(`missing_required_slot(synthesis): the injected brief leaves ${missing.length} required slot(s) unaddressed (${missing.map((s) => s.slot_key).join(", ")}): state each as a cited FACT or an explicit GAP`, [], notes);
    if (input.dry) return { ...runResult("ok", { checked: 1 }, [...notes, "dry: nothing written"]), ok: true, detail: "dry: every check passed, nothing written", errors: [], metadata: v.value };
    const w = await writeSynthesizedBrief(deps, { itemId: input.itemId, itemType: it.item_type, body, metadata: v.value, sourceCount: pool.length, adopted: terms.adopted });
    return { ...w, metadata: v.value, errors: [], notes: [...notes, ...w.notes] } as InjectResult;
  } catch (e) {
    return refused(`inject aborted: ${message(e)}`);
  }
}

/**
 * THE single write site of a brief: full_brief plus the metadata fields, with the contract's gates at the boundary (severity display to DB
 * form, theme held or banked as a candidate, enum sets asserted). what_is_it, why_matters and key_data are COALESCE writes: an honest
 * null never erases a populated value. last_regenerated_at is the real now. related_items become edges, filtered to items that exist.
 */
export async function writeSynthesizedBrief(deps: Deps, a: { itemId: string; itemType: string; body: string; metadata: BriefMetadata; sourceCount: number; adopted?: AdoptedTerms }): Promise<InjectResult> {
  const { sb } = deps;
  const markers = findInternalMarkers(a.body);
  if (markers.length) return refused(`internal_marker_in_body: ${describeMarkers(markers)}`);
  const md = { ...a.metadata };
  const spec = specForItemType(a.itemType);
  if (spec) md.format_type = spec.formatType;
  const nowIso = deps.recorder.now().toISOString();
  const notes: string[] = [];
  let sev: string | null;
  try {
    sev = toDbSeverity(md.severity);
    assertDbValue("priority", md.priority, DB_PRIORITY_VALUES, false);
    assertDbValue("urgency_tier", md.urgency_tier, DB_URGENCY_TIER_VALUES);
    assertDbValue("format_type", md.format_type, DB_FORMAT_TYPE_VALUES);
    assertDbValue("signal_band", md.signal_band, DB_SIGNAL_BAND_VALUES);
  } catch (e) {
    return refused(`metadata_vocab_drift: ${message(e)}`);
  }
  const theme = bankCandidate("theme", md.theme, a.adopted);
  if (theme.candidate) notes.push(`theme "${theme.candidate}" is out of vocabulary: banked in theme_candidate, theme null`);
  const ids = (xs: string[]) => xs.filter((x) => UUID.test(x));
  const patch: Record<string, unknown> = {
    full_brief: cleanCtl(a.body),
    ...(md.what_is_it ? { what_is_it: md.what_is_it } : {}),
    ...(md.why_matters ? { why_matters: md.why_matters } : {}),
    ...(md.key_data.length ? { key_data: md.key_data } : {}),
    severity: sev, priority: md.priority, urgency_tier: md.urgency_tier, format_type: md.format_type, topic_tags: md.topic_tags,
    signal_band: md.signal_band, theme: theme.held, theme_candidate: theme.candidate, trajectory_points: md.trajectory_points,
    what_it_changes: md.what_it_changes, does_not_resolve: md.does_not_resolve, conversion_trigger: md.conversion_trigger, cross_references: md.cross_references,
    cost_mechanism: md.cost_mechanism, penalty_range: md.penalty_range, enforcement_body: md.enforcement_body, requirement_trajectory: md.requirement_trajectory,
    operational_scenario_tags: md.operational_scenario_tags, compliance_object_tags: md.compliance_object_tags, compliance_object_candidates: md.compliance_object_candidates,
    intersection_summary: md.intersection_summary, sources_used: ids(md.sources_used), regeneration_skill_version: md.regeneration_skill_version,
    // item_grade is a CACHE of "this item carries a real synthesized brief": it upgrades in the SAME update as the brief it describes.
    item_grade: "brief", last_regenerated_at: nowIso, updated_at: nowIso,
  };
  const w = await sb.from("intelligence_items").update(patch).eq("id", a.itemId);
  if (w.error) return refused(`metadata_write_rejected: ${w.error.message} (sev=${sev}, fmt=${md.format_type}, theme=${theme.held ?? "null"}, prio=${md.priority})`, [], notes);
  const targets = ids(md.related_items).filter((t) => t !== a.itemId);
  let edges = 0;
  if (targets.length) {
    // An asserted id adds intersection strength, so it is an edge only when the item exists, is verified and is not archived (the admissible-row predicate): anything else is named and dropped, never guessed into the graph.
    const admissible = await admissibleRows.itemIds(sb, targets).catch((e: Error) => e);
    if (admissible instanceof Error) notes.push(`related_items not checked, no edge written: ${admissible.message}`);
    else {
      const dropped = targets.filter((id) => !admissible.has(id));
      if (dropped.length) notes.push(`related_items dropped (not a verified, unarchived item): ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? " and more" : ""}`);
      if (admissible.size) {
        const up = await sb.from("item_cross_references").upsert([...admissible].map((id) => ({ source_item_id: a.itemId, target_item_id: id, relationship: "related", origin: "agent_semantic" })), { onConflict: "source_item_id,target_item_id", ignoreDuplicates: true });
        if (up.error) notes.push(`related_items edges not written: ${up.error.message}`);
        else edges = admissible.size;
      }
    }
  }
  const detail = `brief ${a.body.length}ch + metadata (fmt=${md.format_type}, sev=${sev}) from ${a.sourceCount} pool sources`;
  return { ...runResult(notes.length ? "partial" : "ok", { brief_chars: a.body.length, edges }, notes), ok: true, detail, errors: [] };
}

/** Ground an author's claim ledger (the free grounding entry). Malformed records are refused with their reasons; nothing is half-applied. */
export async function groundInjectedLedger(deps: Deps, input: { itemId: string; ledger: unknown; dry?: boolean; replaceLedger?: boolean; batchId?: string | null; confirmations?: Record<string, { span: string; url: string }> }): Promise<GroundResult> {
  const v = validateClaimRecords(input.ledger);
  if (v.errors.length) {
    return { ...runResult("failed", { claims_in: Array.isArray(input.ledger) ? input.ledger.length : 0, claims_invalid: v.errors.length }, v.errors), ok: false, valid: false, detail: `ledger refused: ${v.errors.length} invalid record(s)`, reasons: [], provenance: null, kept: 0, dropped: 0, slotCandidates: {}, relabels: [] };
  }
  return groundBrief({ sb: deps.sb, sources: deps.sources, now: () => deps.recorder.now() }, { itemId: input.itemId, ledger: v.claims, ...(input.dry ? { dry: true } : {}), ...(input.replaceLedger ? { replaceLedger: true } : {}), batchId: input.batchId ?? null, ...(input.confirmations ? { confirmations: input.confirmations } : {}) });
}

/** Rows for item_timelines from the brief's timeline section; the old rows are replaced only when new ones exist. Both writes are checked. */
export async function harvestItemTimeline(deps: Deps, itemId: string, opts: { dry?: boolean } = {}): Promise<RunResult> {
  const { sb } = deps;
  const r = await sb.from("intelligence_items").select("item_type, full_brief").eq("id", itemId).maybeSingle();
  if (r.error) return runResult("failed", {}, [`item read failed: ${r.error.message}`]);
  const it = r.data as { item_type: string; full_brief: string | null } | null;
  if (!it?.full_brief) return runResult("failed", {}, ["no full_brief"]);
  const h = harvestTimeline(it.full_brief, it.item_type, deps.recorder.now().toISOString().slice(0, 10));
  if (!h.applicable) return runResult("ok", { rows: 0 }, [`no mapped timeline section for item_type ${it.item_type}`]);
  const notes = h.skipped.length ? [`${h.skipped.length} unparseable date token(s) skipped: ${h.skipped.slice(0, 3).map((s) => s.date).join(" | ")}`] : [];
  if (!h.rows.length || opts.dry) return runResult("ok", { rows: h.rows.length, skipped: h.skipped.length }, [...notes, ...(opts.dry ? ["dry: nothing written"] : [])]);
  const del = await sb.from("item_timelines").delete().eq("item_id", itemId);
  if (del.error) return runResult("failed", { rows: 0 }, [...notes, `timeline delete failed: ${del.error.message}`]);
  const ins = await sb.from("item_timelines").insert(h.rows.map((x) => ({ ...x, item_id: itemId })));
  return ins.error ? runResult("failed", { rows: 0 }, [...notes, `timeline insert failed after the delete: ${ins.error.message}`]) : runResult("ok", { rows: h.rows.length, skipped: h.skipped.length }, notes);
}

/**
 * Reconcile intelligence_item_sections with the brief BY KEY in ONE database transaction (ledger_reconcile_sections): surviving keys are updated in place (their section row ids keep the claims
 * pointing at them), new keys inserted, vanished keys deleted AFTER every claim they carry is archived to claim_versions (the delete cascades; nothing is destroyed unarchived). A VERIFIED item is
 * never re-sectioned; only its timeline is harvested.
 */
export async function sectionBrief(deps: Deps, itemId: string, opts: { dry?: boolean } = {}): Promise<RunResult> {
  const { sb } = deps;
  const r = await sb.from("intelligence_items").select("item_type, full_brief, provenance_status").eq("id", itemId).maybeSingle();
  if (r.error) return runResult("failed", {}, [`item read failed: ${r.error.message}`]);
  const it = r.data as { item_type: string; full_brief: string | null; provenance_status: string | null } | null;
  if (!it?.full_brief) return runResult("failed", {}, ["no full_brief"]);
  if (it.provenance_status === "verified") {
    const tl = await harvestItemTimeline(deps, itemId, opts);
    return runResult(tl.outcome, { sections: 0, ...tl.counts }, ["already verified: skip re-section (ledger-preserving)", ...tl.notes]);
  }
  const rows = extractSections(it.full_brief, it.item_type);
  if (!specForItemType(it.item_type)) return runResult("failed", {}, [`no format spec for item_type ${it.item_type}`]);
  if (!rows.length) return runResult("failed", {}, ["no sections extracted"]);
  if (opts.dry) return runResult("ok", { sections: rows.length }, ["dry: nothing written"]);
  const clean = (md: string) => stripUrlMarkers(md) ?? md;
  let reconciled: Awaited<ReturnType<typeof reconcileSections>>;
  try {
    reconciled = await reconcileSections(sb, itemId, rows.map((s) => ({ section_key: s.section_key, section_order: s.section_order, content_md: clean(s.content_md), is_conditional: s.is_conditional })), deps.recorder.now().toISOString());
  } catch (e) {
    return runResult("failed", { sections: rows.length, section_writes_failed: rows.length }, [`sections not reconciled, nothing changed: ${message(e)}`]);
  }
  const tl = await harvestItemTimeline(deps, itemId);
  return runResult(tl.outcome !== "ok" ? "partial" : "ok", { sections: rows.length, section_writes_failed: 0, claims_archived: reconciled.claims_archived, ...tl.counts }, tl.notes);
}

/** Register (and rate, rule 18) the pool hosts and the brief's cited sources BEFORE grounding, so a corroborator-grounded FACT resolves to a real tier instead of null. Idempotent. */
export async function registerBriefSources(deps: Deps, itemId: string, opts: { dry?: boolean } = {}): Promise<RunResult> {
  const { sb, sources } = deps;
  const counts: Record<string, number> = { pool_hosts: 0, cited: 0, refused: 0 };
  const notes: string[] = [];
  const reg = async (url: string, k: string) => {
    try {
      const x = await sources.registerAndRate(url);
      if (x.sourceId) counts[k] = (counts[k] ?? 0) + 1;
      else {
        counts.refused = (counts.refused ?? 0) + 1;
        notes.push(`${url}: not registered${x.refused ? ` (${x.refused})` : ""}`);
      }
    } catch (e) {
      counts.refused = (counts.refused ?? 0) + 1;
      notes.push(`${url}: ${message(e)}`);
    }
  };
  const r = await sb.from("intelligence_items").select("full_brief").eq("id", itemId).maybeSingle();
  if (r.error) return runResult("failed", counts, [`item read failed: ${r.error.message}`]);
  const pool = await readPool(sb, itemId).catch((e: Error) => e);
  if (pool instanceof Error) return runResult("failed", counts, [pool.message]);
  if (opts.dry) return runResult("ok", { pool_urls: pool.length, cited: parseNewSources((r.data as { full_brief: string | null } | null)?.full_brief).length }, ["dry: nothing registered"]);
  for (const p of pool) await reg(p.url, "pool_hosts");
  for (const c of parseNewSources((r.data as { full_brief: string | null } | null)?.full_brief)) await reg(c.url, "cited");
  return runResult(counts.refused ? "partial" : "ok", counts, notes);
}

/** Source growth: register the brief's cited sources and record the citation edges (one batched, checked upsert). Compounding credibility is the sources slice's recompute, run from the turn. */
export async function growSources(deps: Deps, itemId: string, opts: { dry?: boolean } = {}): Promise<RunResult> {
  const { sb, sources } = deps;
  const r = await sb.from("intelligence_items").select("source_id, full_brief").eq("id", itemId).maybeSingle();
  if (r.error) return runResult("failed", {}, [`item read failed: ${r.error.message}`]);
  const it = r.data as { source_id: string | null; full_brief: string | null } | null;
  if (!it?.source_id || !it.full_brief) return runResult("failed", {}, ["no source_id/full_brief"]);
  const cited = parseNewSources(it.full_brief);
  if (opts.dry) return runResult("ok", { cited: cited.length }, ["dry: nothing registered or recorded"]);
  const notes: string[] = [];
  const edges: { citing_source_id: string; cited_source_id: string; context: string }[] = [];
  for (const c of cited) {
    try {
      const x = await sources.registerAndRate(c.url);
      if (x.sourceId && x.sourceId !== it.source_id) edges.push({ citing_source_id: x.sourceId, cited_source_id: it.source_id, context: "brief-citation" });
      else if (!x.sourceId) notes.push(`${c.url}: not registered${x.refused ? ` (${x.refused})` : ""}`);
    } catch (e) {
      notes.push(`${c.url}: ${message(e)}`);
    }
  }
  if (edges.length) {
    const up = await sb.from("source_citations").upsert(edges, { onConflict: "citing_source_id,cited_source_id", ignoreDuplicates: true });
    if (up.error) return runResult("failed", { cited: cited.length, edges: 0 }, [...notes, `citation edges not written: ${up.error.message}`]);
  }
  return runResult(notes.length ? "partial" : "ok", { cited: cited.length, edges: edges.length }, notes);
}
