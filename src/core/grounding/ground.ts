// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1621-1660)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1697-1758)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1771-1790)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1816-1840)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1859-1935)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1945-1990)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 2008-2076)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 2083-2171)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 2172-2290)
// The one grounding entry. The model call that extracted the ledger and the judge that confirmed a slot span are gone: a session
// AUTHORS the ledger (and confirms slot spans), and everything after is the unchanged judgment: cited-host gate, error-body gate,
// target match, resolver tier stamp, official floor pool, the kept filter, slot coverage (a FACT only on the author's confirmation),
// floor-first re-attribution, dominance (INV-158), Gate A and B, the non-destructive apply, mint gates, citation edges and
// validate_item_provenance. A `dry` run computes every stage and writes nothing.
import { bindClaimMarkers } from "@/core/brief/claim-marker";
import { ANALYSIS_LABELS } from "@/core/brief/vocab";
import { crossLinkClaimSources, type ClaimRecord } from "@/core/brief/validate";
import { isVerbatim } from "@/core/contracts/verbatim";
import { boundedRead, fetchAllRows, type Db } from "@/core/db";
import { runResult, type RunResult } from "@/core/intake/result";
import { hostOf, stripUrlMarkers } from "@/core/shared/url";

import type { ResolvedSource, ResolveSource } from "./audit-gate";
import { citedHostGate } from "./cited-hosts";
import { GROUND_CONFIG } from "./config";
import { openFlagOnce } from "./flags";
import type { FactClaim } from "./gate-a-scan";
import { buildCitationEdges, buildGateARow, clearGateAState, derivedCoveredTokens, mergeNullTierAggregate, mintGates, summarizeNullTierAggregate, upsertGateAState, type GateFact, type NullTierAggregate } from "./gates";
import { applyLedgerDiff, applyLedgerOps, diffLedger, ledgerRegression, summarizeLedger, type ClaimRow } from "./ledger";
import { authorityFloorFor, floorPool, readAllPoolRows, reattributeToFloor, type PoolRow } from "./pool";
import { decideSlotClaim, nominateForSlot, readRequiredSlots, type Nomination } from "./slots";

export interface TargetIdentity { title: string | null; item_type: string; instrument_type: string | null; identifier: string | null; canonical_instrument_key: string | null; jurisdiction: string | null }
export interface TargetMatch { verdict: "match" | "mismatch" | "unverified"; reason?: string; expected?: string[]; conflicting?: string[]; score?: number }
export interface GroundSources {
  resolveSource: ResolveSource;
  registerAndRate(url: string): Promise<{ sourceId: string | null; tier: number | null; refused?: string }>;
  matchTarget(pool: { url: string; text: string }[], identity: TargetIdentity): TargetMatch;
  officialness(url: string, text: string, ctx: { hostTier: number | null; floorTier: number | null }): { path: "a" | "b"; cleanBody: string | null };
  classifyBody(body: string): { errorBody: boolean; reason?: string };
}
export interface GroundDeps { sb: Db; sources: GroundSources; now: () => Date }
export interface GroundInput {
  itemId: string;
  /** The author's claim ledger (validated records). */
  ledger: ClaimRecord[];
  dry?: boolean;
  /** A COMPLETE, author-checked ledger: a prior claim it does not reproduce is archived and dropped, and the dominance guard does not bind. */
  replaceLedger?: boolean;
  batchId?: string | null;
  /** slot_key to the nomination the author confirms as the binding FACT; it must be verbatim in a pool source of the nomination pool. */
  confirmations?: Record<string, Nomination>;
}
export interface GroundResult extends RunResult {
  ok: boolean;
  valid: boolean;
  detail: string;
  reasons: string[];
  provenance: string | null;
  kept: number;
  dropped: number;
  /** Verbatim candidates per uncovered slot, for the author to confirm in the next round. */
  slotCandidates: Record<string, Nomination[]>;
  relabels: { slot_key: string; reason: string }[];
}

interface ItemRow { id: string; item_type: string; source_id: string | null; source_url: string | null; full_brief: string | null; title: string | null; instrument_type: string | null; instrument_identifier: string | null; canonical_instrument_key: string | null; jurisdiction_iso: string | null; provenance_status: string | null }
const NONE: ResolvedSource = { tier: null, institution: null, sourceId: null };
const ITEM_COLUMNS = "id, item_type, source_id, source_url, full_brief, title, instrument_type, instrument_identifier, canonical_instrument_key, jurisdiction_iso, provenance_status";

function failed(detail: string, notes: string[], counts: Record<string, number> = {}, extra: Partial<GroundResult> = {}): GroundResult {
  return { ...runResult("failed", counts, [detail, ...notes]), ok: false, valid: false, detail, reasons: [], provenance: null, kept: 0, dropped: 0, slotCandidates: {}, relabels: [], ...extra };
}

/** Ground an author-injected ledger against the item's stored pool. Reads that fail make the run fail closed; nothing here exits the process. */
export async function groundBrief(deps: GroundDeps, input: GroundInput): Promise<GroundResult> {
  try {
    return await ground(deps, input);
  } catch (e) {
    return failed(`ground aborted: ${e instanceof Error ? e.message : String(e)}`, []);
  }
}

async function ground(deps: GroundDeps, input: GroundInput): Promise<GroundResult> {
  const { sb, sources } = deps;
  const dry = input.dry === true;
  const itemId = input.itemId;
  const nowIso = deps.now().toISOString();
  const notes: string[] = [];
  const push = (n: string | null) => void (n && notes.push(n));
  const counts: Record<string, number> = { claims_in: input.ledger.length };

  const itemRes = await sb.from("intelligence_items").select(ITEM_COLUMNS).eq("id", itemId).maybeSingle();
  if (itemRes.error) return failed(`item read failed: ${itemRes.error.message}`, notes);
  const it = itemRes.data as ItemRow | null;
  if (!it) return failed("item not found", notes);
  if (!it.source_id) return failed("no source_id", notes);
  if (it.provenance_status === "verified") return { ...runResult("ok", counts, ["already verified"]), ok: true, valid: true, detail: "already verified", reasons: [], provenance: "verified", kept: 0, dropped: 0, slotCandidates: {}, relabels: [] };

  const prior = await fetchAllRows<ClaimRow>((from, to) => sb.from("section_claim_provenance").select("id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason").eq("intelligence_item_id", itemId).order("id", { ascending: true }).range(from, to), { cap: 20_000 }).catch((e: Error) => e);
  if (prior instanceof Error) return failed(`grounding aborted: prior-ledger read failed (${prior.message}); refusing to re-ground under a blind comparison`, notes);
  const secRes = await boundedRead<{ id: string; section_key: string; content_md: string | null }>((limit) => sb.from("intelligence_item_sections").select("id, section_key, content_md").eq("item_id", itemId).order("section_order", { ascending: true }).limit(limit), { limit: 100 });
  if (secRes.error) return failed(`sections read failed: ${secRes.error.message}`, notes);
  const secs = secRes.data;
  if (!secs.length) return failed("no sections", notes);

  // ---- pool, error-body gate, cited-host gate -------------------------------------------------------------
  const allRows = await readAllPoolRows(sb, itemId);
  const content = allRows.filter((r) => r.text.length > GROUND_CONFIG.MIN_USABLE_POOL_CHARS);
  const bodies = content.map((r) => ({ r, c: sources.classifyBody(r.text) }));
  const errorBodies = bodies.filter((b) => b.c.errorBody).map((b) => b.r);
  const pool: PoolRow[] = bodies.filter((b) => !b.c.errorBody).map((b) => b.r);
  if (errorBodies.length && !dry) {
    push(await openFlagOnce(sb, {
      category: "source_issue", subject_type: "item", subject_ref: itemId, created_by: "error-body-gate",
      description: `${errorBodies.length} stored capture(s) excluded from grounding as failed fetches (bot wall / 403 / 404 / nav shell): ${errorBodies.map((e) => e.url).slice(0, 6).join("; ")}`,
      recommended_actions: errorBodies.slice(0, 8).map((e) => ({ action: "refetch_source", rationale: `${e.url}: stored capture is a failed fetch: re-capture the real source, then re-ground` })),
    }));
  }
  const cited = await citedHostGate(sb, sources.resolveSource, { itemId, sourceUrl: it.source_url, fullBrief: it.full_brief, sections: secs, usablePool: pool, allPoolUrls: new Set(allRows.map((r) => r.url)), nowIso, dry });
  notes.push(...cited.notes);
  counts.cited_stubs = cited.stubbed;
  counts.cited_novel = cited.novel.size;
  if (!pool.length) return failed("no grounding content (no usable stored capture)", notes, counts);

  // ---- target match ---------------------------------------------------------------------------------------------
  const tm = sources.matchTarget(pool, { title: it.title, item_type: it.item_type, instrument_type: it.instrument_type, identifier: it.instrument_identifier, canonical_instrument_key: it.canonical_instrument_key, jurisdiction: it.jurisdiction_iso });
  if (tm.verdict !== "match" && !dry) {
    const hard = tm.verdict === "mismatch";
    push(await openFlagOnce(sb, {
      category: hard ? "data_integrity" : "coverage_gap", subject_type: "item", subject_ref: itemId, created_by: hard ? "target_mismatch_gate" : "target_unverified_gate",
      description: hard ? `Target-instrument MISMATCH: the fetched primary is a DIFFERENT instrument than the item. ${tm.reason ?? ""}` : `Target-match UNVERIFIED (soft): grounding proceeds under verbatim and floor gates but the capture is not confirmed to be this instrument. ${tm.reason ?? ""}`,
      ...(hard ? { recommended_actions: [{ action: "re-acquire the correct instrument", rationale: `capture bears ${(tm.conflicting ?? []).join(", ")}; the item's own identifier (${(tm.expected ?? []).join(", ")}) is absent: re-point the source and re-ground` }] } : {}),
    }));
  }
  if (tm.verdict === "mismatch") return failed(`target-instrument MISMATCH: ${tm.reason ?? "fetched primary is a different instrument"}: held, not ground`, notes, counts);

  // ---- tiers, floor pool, suspended sources ---------------------------------------------------------------------
  const tierOf = new Map<string, number | null>();
  for (const r of pool) if (!tierOf.has(r.url)) tierOf.set(r.url, (await sources.resolveSource(r.url))?.tier ?? null);
  const withTier = pool.map((r) => ({ url: r.url, text: r.text, tier: tierOf.get(r.url) ?? null }));
  const itemFloor = authorityFloorFor(it.item_type);
  const official: typeof withTier = [];
  for (const s of floorPool(withTier, itemFloor)) {
    const off = sources.officialness(s.url, s.text, { hostTier: s.tier, floorTier: itemFloor });
    if (off.path === "a") official.push({ ...s, text: off.cleanBody || s.text });
  }
  const suspended = await fetchAllRows<{ id: string }>((from, to) => sb.from("sources").select("id").eq("status", "suspended").order("id", { ascending: true }).range(from, to), { cap: 50_000 });

  // ---- the kept filter (verbatim, case-insensitive like criterion 3; ANALYSIS must sit under a label) ----------------
  const claims = input.ledger.map((c) => ({ ...c, source_url: c.source_url ? (stripUrlMarkers(c.source_url) as string) : null }));
  const sectionsLc = secs.map((s) => (s.content_md ?? "").toLowerCase());
  const analysisGrounded = (text: string) => { const ct = text.toLowerCase().trim(); return ct.length > 0 && sectionsLc.some((t) => ANALYSIS_LABELS.some((l) => t.includes(l)) && t.includes(ct)); };
  const kept: ClaimRecord[] = claims.filter((c) => {
    if (c.claim_kind === "FACT") return !!c.source_span && pool.some((r) => isVerbatim(r.text, c.source_span));
    return c.claim_kind === "ANALYSIS" ? analysisGrounded(c.claim_text) : true;
  });
  counts.kept = kept.length;
  counts.dropped = claims.length - kept.length;

  // ---- slot coverage: a FACT only on the author's confirmation, else GAP or RELABEL -------------------------------
  const slots = await readRequiredSlots(sb, it.item_type);
  const slotCandidates: Record<string, Nomination[]> = {};
  const relabels: { slot_key: string; reason: string }[] = [];
  const tagged = new Set(kept.filter((c) => (c.claim_kind === "FACT" || c.claim_kind === "GAP") && c.slot_key).map((c) => c.slot_key));
  const sentences = secs.map((s) => ({ key: s.section_key, sents: String(s.content_md ?? "").split(/(?<=[.!?])\s+/).map((x) => x.trim()) }));
  const nomPool = itemFloor == null ? withTier : official;
  for (const slot of slots.filter((s) => !tagged.has(s.slot_key))) {
    const want = new Set(String(slot.description || slot.slot_key).toLowerCase().match(/[a-z]{4,}/g) ?? []);
    let proseCovers = false;
    let sectionKey = secs[0]?.section_key ?? "";
    for (const sec of sentences) for (const s of sec.sents) if (s && [...want].some((w) => s.toLowerCase().includes(w))) { proseCovers = true; sectionKey = sec.key; }
    const noms = nominateForSlot(slot.description, nomPool, slot.slot_key).slice(0, GROUND_CONFIG.MAX_NOMINATIONS_PER_SLOT);
    const conf = input.confirmations?.[slot.slot_key];
    const confirmed = !!conf && conf.span.trim().length >= GROUND_CONFIG.MIN_SPAN_CHARS && nomPool.some((s) => s.url === conf.url && isVerbatim(s.text, conf.span));
    if (conf && !confirmed) notes.push(`slot ${slot.slot_key}: the confirmation is not a verbatim span of a floor-pool source and was refused`);
    const d = decideSlotClaim({ slotKey: slot.slot_key, nomination: confirmed ? (conf as Nomination) : null, confirmed, proseCovers });
    if (noms.length) slotCandidates[slot.slot_key] = noms;
    if (d.kind === "FACT") kept.push({ claim_kind: "FACT", claim_text: d.source_span as string, source_span: d.source_span as string, source_id: null, source_url: d.source_url as string, slot_key: d.slot_key, section: sectionKey, search_result_id: null });
    else if (d.kind === "GAP") kept.push({ claim_kind: "GAP", claim_text: `[${d.slot_key}] not available from primary sources as of grounding`, source_span: null, source_id: null, source_url: null, slot_key: d.slot_key, section: sectionKey, search_result_id: null });
    else relabels.push({ slot_key: d.slot_key, reason: d.reason });
  }

  // ---- attribution: content-first link, floor-first re-home, resolver stamp, register and rate (rule 18) -------------
  const linked = crossLinkClaimSources(kept, allRows.map((r) => ({ id: r.id, result_url: r.url, result_content: r.text })));
  const urlBySearchId = new Map(allRows.map((r) => [r.id, r.url]));
  const idByUrl = new Map<string, string>();
  for (const r of allRows) if (!idByUrl.has(r.url)) idByUrl.set(r.url, r.id);
  const sectionId = Object.fromEntries(secs.map((s) => [String(s.section_key), s.id]));
  const rated = new Map<string, { sourceId: string | null; tier: number | null; refused?: string }>();
  const nullTier = new Map<string, { factCount: number; samples: string[] }>();
  const incoming: ClaimRow[] = [];
  const citedIds = new Set<string>();
  let facts = 0;
  let floorQualifying = 0;
  for (const c of linked) {
    const isFact = c.claim_kind === "FACT";
    const spanUrl = c.search_result_id ? urlBySearchId.get(c.search_result_id) : undefined;
    let res: ResolvedSource = spanUrl ? ((await sources.resolveSource(spanUrl)) ?? NONE) : NONE;
    let effUrl = spanUrl;
    let effId = c.search_result_id ?? null;
    if (isFact) {
      const home = reattributeToFloor(c.source_span, res.tier, official, itemFloor);
      if (home) {
        effUrl = home.url;
        res = (await sources.resolveSource(home.url)) ?? NONE;
        effId = idByUrl.get(home.url) ?? effId;
      }
    }
    if (isFact && res.tier == null && effUrl) {
      const host = hostOf(effUrl);
      if (host && !dry && !rated.has(host)) rated.set(host, await sources.registerAndRate(effUrl).catch((e: Error) => ({ sourceId: null, tier: null, refused: `register failed: ${e.message}` })));
      const r = rated.get(host);
      if (r && r.tier != null) res = { tier: r.tier, sourceId: r.sourceId, institution: null };
      else if (host) {
        const agg = nullTier.get(host) ?? { factCount: 0, samples: [] };
        agg.factCount += 1;
        if (agg.samples.length < 3 && c.source_span) agg.samples.push(c.source_span.slice(0, 160));
        nullTier.set(host, agg);
      }
    }
    const sourceId = isFact ? res.sourceId : spanUrl ? (res.sourceId ?? c.source_id ?? it.source_id) : (c.source_id || it.source_id);
    const alreadyTagged = !!c.slot_key && String(c.claim_text).trimStart().toLowerCase().startsWith(`[${c.slot_key.toLowerCase()}]`);
    const text = (c.claim_kind === "FACT" || c.claim_kind === "GAP") && c.slot_key && !alreadyTagged ? `[${c.slot_key}] ${c.claim_text}` : c.claim_text;
    incoming.push({ section_row_id: sectionId[String(c.section)] ?? secs[0]?.id ?? null, claim_text: text, claim_kind: c.claim_kind, source_span: c.source_span, source_id: sourceId ?? null, search_result_id: effId, source_tier_at_grounding: isFact ? res.tier : null });
    if (isFact) {
      facts += 1;
      if (itemFloor != null && res.tier != null && res.tier <= itemFloor) floorQualifying += 1;
    }
    if (sourceId) citedIds.add(sourceId);
  }

  // ---- dominance (INV-158) ----------------------------------------------------------------------------------------
  const reg = ledgerRegression(summarizeLedger(prior, itemFloor), { total: incoming.length, facts, floorQualifying, wouldVerify: false });
  if (reg.regression && !input.replaceLedger) {
    const priorS = summarizeLedger(prior, itemFloor);
    const detail = `re-ground REGRESSION [${reg.axes.join(",")}]: facts ${priorS.facts}->${facts}, floor-qual ${priorS.floorQualifying}->${floorQualifying}, total ${priorS.total}->${incoming.length}; prior ledger retained, new grounding not applied`;
    if (!dry) push(await openFlagOnce(sb, { category: "data_integrity", subject_type: "item", subject_ref: itemId, created_by: "reground_regression_guard", description: `${detail}. A weaker ledger did not replace the stronger prior: investigate the pool and the authored ledger.`, recommended_actions: [{ action: "investigate extraction", rationale: detail }] }));
    return failed(detail, notes, counts, { slotCandidates, relabels, kept: kept.length, dropped: counts.dropped ?? 0 });
  }

  // ---- Gate A (before the claim writes, so criterion 7 finds current state), then the non-destructive apply ---------
  // A FACT is read under the number locale its own capture declares (agent_run_searches.number_locale), so a figure the capture prints as "1.200,5" is never read as 1.2.
  const localeOf = new Map(allRows.map((r) => [r.id, r.number_locale]));
  const factsOf = (rows: { claim_kind: string; claim_text: string | null; source_span: string | null; search_result_id?: string | null }[]): FactClaim[] =>
    rows.filter((c) => c.claim_kind === "FACT").map((c) => ({ claim_text: c.claim_text ?? "", source_span: c.source_span ?? "", locale: localeOf.get(c.search_result_id ?? "") ?? null }));
  const derivedCovered = await derivedCoveredTokens(sb, itemId);
  if (!dry) {
    const ga = await upsertGateAState(sb, buildGateARow({ itemId, fullBrief: it.full_brief, factClaims: factsOf([...prior, ...incoming]), derivedCovered, nowIso }));
    if (ga.error) notes.push(`gate-a state not written: ${ga.error}`);
  }
  const applyRes = await applyLedgerDiff(sb, itemId, diffLedger(prior, incoming), { nowIso, replaceLedger: input.replaceLedger === true, batchId: input.batchId ?? null, dry });
  notes.push(...applyRes.notes);
  Object.assign(counts, { claims_added: applyRes.applied.added, claims_changed: applyRes.applied.changed, claims_unchanged: applyRes.applied.unchanged, claims_kept_not_reproduced: applyRes.applied.notReproduced, claims_versioned: applyRes.applied.versioned, claims_archived: applyRes.applied.archived, claim_writes_failed: applyRes.applied.failed });
  if (applyRes.applied.failed > 0 && !dry) {
    // Phantom coverage: the Gate A state was computed from the in-memory set. Rescan against what actually persisted; if that cannot complete, blank it so criterion 7 quarantines.
    const persisted = await fetchAllRows<ClaimRow>((from, to) => sb.from("section_claim_provenance").select("id, claim_kind, claim_text, source_span, source_id, search_result_id, source_tier_at_grounding").eq("intelligence_item_id", itemId).order("id", { ascending: true }).range(from, to), { cap: 20_000 }).catch(() => null);
    const w = persisted ? await upsertGateAState(sb, buildGateARow({ itemId, fullBrief: it.full_brief, factClaims: factsOf(persisted), derivedCovered: await derivedCoveredTokens(sb, itemId), nowIso })) : { error: "persisted-claims read failed" };
    if (w.error) { const c = await clearGateAState(sb, itemId); notes.push(`gate-a reconcile failed (${w.error}); state ${c.error ? `NOT cleared (${c.error})` : "cleared (fail-closed)"}`); }
  }

  // ---- name the claim in each fact paragraph (K:50): the claims now have their ids, so the paragraph that states one is marked with it and the render never compares text -----------------------------------
  if (!dry) {
    const facts = await fetchAllRows<{ id: string; claim_text: string }>((from, to) => sb.from("section_claim_provenance").select("id, claim_text").eq("intelligence_item_id", itemId).eq("claim_kind", "FACT").order("id", { ascending: true }).range(from, to), { cap: 20_000 }).catch((e: Error) => e);
    if (facts instanceof Error) notes.push(`claim markers not written: the claim read failed (${facts.message})`);
    else {
      const bound = secs.map((s) => ({ s, b: bindClaimMarkers(s.content_md ?? "", facts) }));
      Object.assign(counts, { paragraphs_marked: bound.reduce((n, x) => n + x.b.marked, 0), paragraphs_unmarked: bound.reduce((n, x) => n + x.b.unmarked, 0) });
      const ops = bound.filter((x) => x.b.markdown !== (x.s.content_md ?? "")).map((x) => ({ op: "section_content" as const, id: x.s.id, content_md: x.b.markdown }));
      if (ops.length) await applyLedgerOps(sb, itemId, ops, nowIso).catch((e: Error) => void notes.push(`claim markers not written: ${e.message}`));
    }
  }

  // ---- mint gates, citation edges, null-tier surfacing -----------------------------------------------------------
  const gateFacts: GateFact[] = applyRes.touchedFacts;
  const report = mintGates(gateFacts, { itemFloor, suspendedSourceIds: suspended.map((s) => s.id) });
  // Both gates are HOLDS (a FACT with mint_hold_reason set fails criterion 3 of validate_item_provenance): a claim that trips both keeps S-CONFLATE, which names the wrong source; a re-ground clears and re-judges both.
  const conflated = new Set(report.conflateHeldIds);
  const holds: [string, string[]][] = [["S-CONFLATE", report.conflateHeldIds], ["S-NUMERIC", report.numericHeldIds.filter((id) => !conflated.has(id))]];
  Object.assign(counts, { mint_hold_conflate: holds[0]?.[1].length ?? 0, mint_hold_numeric: holds[1]?.[1].length ?? 0 });
  if (!dry) {
    for (const [reason, ids] of holds) {
      if (!ids.length) continue;
      const h = await sb.from("section_claim_provenance").update({ mint_hold_reason: reason }).in("id", ids);
      if (h.error) notes.push(`${reason} hold update failed: ${h.error.message}`);
    }
    if (citedIds.size) {
      const e = await sb.from("intelligence_item_citations").upsert(buildCitationEdges(itemId, citedIds, nowIso), { onConflict: "intelligence_item_id,source_id,origin", ignoreDuplicates: true });
      if (e.error) notes.push(`citation edges not written: ${e.error.message}`);
    }
    for (const [host, contribution] of nullTier) {
      const open = await sb.from("integrity_flags").select("id, recommended_actions").eq("created_by", "null-tier-host").eq("subject_ref", host).eq("status", "open").limit(1).maybeSingle();
      if (open.error) { notes.push(`null-tier flag for ${host}: read failed: ${open.error.message}`); continue; }
      const priorAgg = ((open.data?.recommended_actions as { aggregate?: NullTierAggregate }[] | null)?.[0]?.aggregate ?? null) as NullTierAggregate | null;
      const refused = rated.get(host)?.refused;
      const s = summarizeNullTierAggregate(host, mergeNullTierAggregate(priorAgg, itemId, contribution), refused === "aggregator" || refused === "platform" ? refused : null);
      const row = { category: "source_issue", subject_type: "source", subject_ref: host, created_by: "null-tier-host", status: "open", description: s.description.slice(0, 480), recommended_actions: [{ action: s.action, rationale: s.rationale, aggregate: mergeNullTierAggregate(priorAgg, itemId, contribution) }] };
      const w = open.data?.id ? await sb.from("integrity_flags").update(row).eq("id", open.data.id) : await sb.from("integrity_flags").insert(row);
      if (w.error) notes.push(`null-tier flag for ${host} not written: ${w.error.message}`);
    }
  }
  counts.null_tier_hosts = nullTier.size;

  // ---- the provenance verdict ---------------------------------------------------------------------------------------
  if (dry) return { ...runResult("ok", counts, [...notes, "dry: nothing written, no verdict"]), ok: true, valid: false, detail: `dry: ${kept.length} kept, ${claims.length - kept.length} dropped`, reasons: [], provenance: null, kept: kept.length, dropped: claims.length - kept.length, slotCandidates, relabels };
  const rpc = await sb.rpc("validate_item_provenance", { p_item_id: itemId });
  const vr = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as { valid?: boolean; recommended_status?: string; failures?: { reason?: string }[] } | null | undefined;
  const status = await sb.from("intelligence_items").select("provenance_status").eq("id", itemId).maybeSingle();
  const provenance = (status.data as { provenance_status?: string } | null)?.provenance_status ?? null;
  const reasons = [...new Set((Array.isArray(vr?.failures) ? vr.failures : []).map((f) => f?.reason).filter((r): r is string => !!r))];
  const valid = !rpc.error && vr?.valid === true;
  const detail = rpc.error ? `rpc error: ${rpc.error.message}` : valid ? `grounded kept=${kept.length} -> ${vr?.recommended_status ?? "verified"}` : `validation failed [${reasons.join(",")}]`;
  const outcome = valid && applyRes.applied.failed === 0 ? "ok" : valid ? "partial" : "failed";
  return { ...runResult(outcome, counts, notes), ok: valid, valid, detail, reasons, provenance, kept: kept.length, dropped: claims.length - kept.length, slotCandidates, relabels };
}
