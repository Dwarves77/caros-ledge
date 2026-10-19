// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2845-2907)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2946-3006)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 3601-3634)
// Ported from old_repo/scripts/mint/rederive-record-provenance.mjs (lines 1-85)
// Per-item provenance healing, in order: capture (when the item has none), ground each FACT in a capture and put its attribution right, cover missing required slots, link the source's institution,
// capture the cited pages, re-source a below-floor FACT from a better capture, re-kind what still cannot be proven (never rewriting), ground the Gate A orphans (buckets first, then source-and-rate),
// the opt-in honest strip, relabel, rewrite the Gate A state, and re-derive (validate, touch, read the fresh status; un-archive an archived-unreasoned item that now verifies).
// Every ledger change of the pass is PLANNED as an op (the claim attribution through reattributionOp: the source and so the tier come from the capture's own host, never the item's) and applied at the
// end as ONE transaction (ledger_apply_ops: archive first, all or nothing); a refusal fails the item with the rule named and nothing changed. Every read and write is checked. Dry mode plans and writes nothing.
import { randomUUID } from "node:crypto";

import { classifyHost } from "@/core/intake";
import { capture } from "@/core/fetch";
import { isVerbatim } from "@/core/contracts/verbatim";
import { fetchAllRows, type Db } from "@/core/db";
import { authorityFloorFor, buildGateARow, derivedCoveredTokens, readRequiredSlots, scanGateA, upsertGateAState } from "@/core/grounding";
import { applyLedgerOps, reattributionOp, sourceForCapture, type AttributionCtx, type LedgerOp } from "@/core/grounding/ledger";
import { runResult, type RunResult } from "@/core/intake/result";
import { buildResolver, registerAndRate, type SourceRow } from "@/core/sources";
import { buildRecordSlotClaim } from "@/features/intake";
import { canonicalUrl } from "@/core/shared";

import type { CaptureDeps } from "../deps";

import { planBriefHonest } from "./brief-honest";
import { briefSentenceOf, buildBuckets, buildSourcesIndex, claimNeedsResource, findOwningSection, NO_VERBATIM_SPAN, planGrounding, planOrphan, planResource, type Capture, type HealClaim, type HealSource, type IndexCache } from "./ground";
import { planReclassify, planRelabelFromFullBrief, planRelabelModal, planRelabelParagraph, sectionNeedsRelabel, type Sec } from "./label";
import { capturePage, sourceOrphans, type SourceCtx } from "./source";

/** `registry` is the sources registry read once by the caller (a sweep); absent, the item reads it itself. */
export interface HealDeps { sb: Db; now(): Date; fetch: CaptureDeps; registry?: HealSource[] }
export interface HealItemInput { itemId: string; dry?: boolean; stripUnprovable?: boolean; selection?: "quarantined" | "archived-unreasoned" | "ids" }
export type HealItemResult = RunResult & { itemId: string; status: string | null; steps: Record<string, unknown>; restore?: { itemId: string; previous: string } };
interface ItemRow { id: string; item_type: string; priority: string | null; source_id: string | null; source_url: string | null; canonical_instrument_key: string | null; full_brief: string | null; is_archived: boolean; provenance_status: string | null }
const ITEM_COLUMNS = "id, item_type, priority, source_id, source_url, canonical_instrument_key, full_brief, is_archived, provenance_status";
const CLAIM_COLUMNS = "id, claim_kind, claim_text, source_span, source_id, search_result_id, section_row_id, basis_claim_id, source_tier_at_grounding";
const REGISTRY_COLUMNS = "id, url, base_tier, tier_override, status, institution_id";
const MAX_CITED = 25;
const CITED_URL = /https?:\/\/(?:[^\s()\]}"'<>]|\([^\s()]*\))+/g;

const must = <T extends { error: { message: string } | null }>(step: string, r: T): T => {
  if (r.error) throw new Error(`${step}: ${r.error.message}`);
  return r;
};
const all = <T>(sb: Db, table: string, columns: string, col: string, id: string, order = "id") => fetchAllRows<T>((from, to) => sb.from(table).select(columns).eq(col, id).order(order, { ascending: true }).range(from, to) as never, { cap: 50_000 });
const readRegistry = (sb: Db) => fetchAllRows<HealSource>((from, to) => sb.from("sources").select(REGISTRY_COLUMNS).order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 });

export async function healItem(deps: HealDeps, input: HealItemInput): Promise<HealItemResult> {
  const { sb } = deps;
  const dry = input.dry ?? true;
  const nowIso = deps.now().toISOString();
  const steps: Record<string, unknown> = {};
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => void (counts[k] = (counts[k] ?? 0) + n);
  const notes: string[] = [];
  const fail = (e: unknown, status: string | null = null): HealItemResult => ({ ...runResult("failed", counts, [...notes, e instanceof Error ? e.message : String(e)]), itemId: input.itemId, status, steps });
  let item!: ItemRow;
  try {
    const r = must("item read", await sb.from("intelligence_items").select(ITEM_COLUMNS).eq("id", input.itemId).maybeSingle());
    if (!r.data) return fail(new Error(`item ${input.itemId} not found`));
    item = r.data as ItemRow;
    const cache: IndexCache = new Map();
    const captures = await all<Capture>(sb, "agent_run_searches", "id, result_url, result_content", "intelligence_item_id", input.itemId);
    const sourceRows = deps.registry ?? (await readRegistry(sb));
    const idx = buildSourcesIndex(sourceRows);
    const resolver = buildResolver(sourceRows.filter((s) => !!s.url) as SourceRow[]);
    const captureById = (id: string | null | undefined): Capture | undefined => captures.find((c) => c.id === id);

    // The ledger plan of this pass, and how a capture's own host resolves to its registered source (rule 18: an unknown host is registered and rated, a host that cannot be rated leaves the FACT unrated).
    const ops: LedgerOp[] = [];
    const attr: AttributionCtx = {
      resolve: (url) => {
        const hit = resolver.resolveSpan(url);
        return hit.sourceId ? { sourceId: hit.sourceId } : null;
      },
      ...(dry ? {} : { register: async (url: string) => { const reg = await registerAndRate(sb, url); return { sourceId: reg.status === "registered" || reg.status === "existing" ? reg.source_id : null }; } }),
    };
    /** Stand a FACT on `cap` with `span`: the planned op, and the in-memory claim moved with it for the steps after. */
    const repoint = async (c: HealClaim, cap: Capture, span: string, why: string): Promise<void> => {
      const op = (await reattributionOp(c, { id: cap.id, url: cap.result_url ?? "" }, span, attr, `heal:${why}`)) as Extract<LedgerOp, { op: "claim" }>;
      if (!dry) ops.push(op);
      Object.assign(c, { source_span: span, search_result_id: cap.id, source_id: op.row.source_id as string | null, source_tier_at_grounding: resolver.resolveSpan(cap.result_url ?? "").tier });
    };

    // 1. capture, when the item has no usable capture of its own
    if (!captures.some((c) => c.result_content.trim().length > 200)) {
      const url = item.source_url ?? (item.source_id ? idx.byId.get(item.source_id)?.url ?? null : null);
      if (!url) steps.capture = "held:no_source_url";
      else if (dry) steps.capture = "would_fetch";
      else {
        const key = item.canonical_instrument_key;
        const res = await capture(url, classifyHost(url) === "eurlex" && key ? { family: "celex", key } : { family: "generic" }, deps.fetch);
        if (res.usable && res.text) {
          const ins = must("pool row insert", await sb.from("agent_run_searches").insert({ intelligence_item_id: item.id, search_query: "heal-provenance:capture", result_url: url, result_title: res.title, result_index: captures.length, result_content: res.text, searched_at: nowIso }).select("id").single());
          captures.push({ id: (ins.data as { id: string }).id, result_url: url, result_content: res.text });
          steps.capture = `captured:${res.transport}`;
        } else steps.capture = `held:${res.holdReason ?? "capture_failed"}`;
      }
    } else steps.capture = "already_captured";

    const claims = await all<HealClaim>(sb, "section_claim_provenance", CLAIM_COLUMNS, "intelligence_item_id", item.id);
    const sections = await all<Sec & { section_order: number }>(sb, "intelligence_item_sections", "id, section_key, section_order, content_md", "item_id", item.id);
    const recordSection = (): string => {
      const have = sections.find((s) => s.section_key === "record_facts");
      if (have) return have.id;
      const s = { id: randomUUID(), section_key: "record_facts", section_order: Math.max(1, ...sections.map((x) => x.section_order ?? 0)) + 1, content_md: "" };
      if (!dry) ops.push({ op: "section_insert", id: s.id, section_key: s.section_key, section_order: s.section_order, content_md: "", is_conditional: false });
      sections.push(s);
      return s.id;
    };
    const setSectionText = (s: Sec, md: string): void => {
      if (!dry) ops.push({ op: "section_content", id: s.id, content_md: md });
      s.content_md = md;
    };

    // 2. ground each FACT in a capture (the span re-pointed; the claim text is never touched), and put an already-grounded FACT's attribution right: the source and tier of ITS capture's host
    const groundOutcome = new Map<string, string>();
    for (const c of claims.filter((x) => x.claim_kind === "FACT")) {
      const p = planGrounding(c, captures, cache);
      groundOutcome.set(c.id, p.outcome);
      if (p.outcome === "healed") {
        await repoint(c, captureById(p.searchId) as Capture, p.newSpan, "ground");
        bump("ground_healed");
      } else if (p.outcome === "already_grounded") {
        const own = captureById(c.search_result_id) as Capture;
        const want = resolver.resolveSpan(own.result_url ?? "");
        if ((want.sourceId ?? null) !== (c.source_id ?? null) || (want.tier ?? null) !== (c.source_tier_at_grounding ?? null)) {
          await repoint(c, own, c.source_span as string, "attribution");
          bump("attribution_repaired");
        }
      } else if (p.outcome === "ungrounded_after_capture") bump("ungrounded");
    }

    // 3. required slots no claim covers yet
    const required = (await readRequiredSlots(sb, item.item_type)).map((s) => s.slot_key);
    const best = captures.filter((c) => c.result_content.trim().length > 200).sort((a, b) => b.result_content.length - a.result_content.length)[0];
    const covered = (k: string) => claims.some((c) => (c.claim_kind === "FACT" || c.claim_kind === "GAP") && c.claim_text.toLowerCase().includes(k.toLowerCase()));
    for (const slot of required.filter((k) => !covered(k))) {
      if (!best) { bump("slots_held_no_capture"); continue; }
      const sc = buildRecordSlotClaim(slot, { capturedText: best.result_content, sourceUrl: item.source_url });
      bump("slots_missing");
      if (dry) continue;
      const holder = sc.claim_kind === "FACT" ? captures.find((c) => isVerbatim(c.result_content, sc.source_span)) : undefined;
      if (sc.claim_kind === "FACT" && !holder) { notes.push(`slot ${slot}: the span is in no held capture; nothing written`); continue; }
      const sectionId = recordSection();
      const row = holder
        ? { section_row_id: sectionId, claim_text: sc.claim_text, claim_kind: "FACT", source_span: sc.source_span, source_id: await sourceForCapture(holder.result_url ?? "", attr), search_result_id: holder.id }
        : { section_row_id: sectionId, claim_text: sc.claim_text, claim_kind: sc.claim_kind, source_span: sc.source_span, source_id: null, search_result_id: null };
      ops.push({ op: "claim", claim_id: null, row });
      claims.push({ id: `pending:${ops.length}`, claim_kind: row.claim_kind, claim_text: row.claim_text, source_span: row.source_span, source_id: row.source_id, search_result_id: row.search_result_id, section_row_id: sectionId });
      const sec = sections.find((s) => s.id === sectionId) as Sec;
      setSectionText(sec, [sec.content_md ?? "", sc.claim_text].filter(Boolean).join("\n"));
      bump("slots_written");
    }

    // 4. the source's institution link (a registry read-and-link; the tier is never changed here)
    const itemSource = item.source_id ? idx.byId.get(item.source_id) ?? null : null;
    if (itemSource && itemSource.institution_id == null && itemSource.url) {
      if (dry) steps.institution = "would_link";
      else {
        const reg = await registerAndRate(sb, itemSource.url);
        if (reg.status === "registered" || reg.status === "existing") Object.assign(itemSource, { institution_id: reg.institution_id });
        steps.institution = reg.status;
      }
    }

    // 5. the cited pages the item does not yet hold a capture of (bounded)
    const ctx: SourceCtx = { sb, fetch: deps.fetch, dry, nowIso, itemId: item.id, idx, cache, capCache: new Map(), captures, claims, fullBrief: item.full_brief, ops, sections, sectionFor: async (token) => findOwningSection(token, sections)?.id ?? recordSection() };
    const heldUrls = new Set(captures.map((c) => canonicalUrl(c.result_url)));
    const cited = [...new Set([...sections.flatMap((s) => [...(s.content_md ?? "").matchAll(CITED_URL)].map((m) => m[0])), ...claims.flatMap((c) => (c.source_id ? [idx.byId.get(c.source_id)?.url ?? ""] : []))].filter(Boolean))].filter((u) => !heldUrls.has(canonicalUrl(u))).slice(0, MAX_CITED);
    if (!dry) for (const u of cited) { if (await capturePage(ctx, u).catch(() => null)) bump("cited_captured"); }
    else bump("cited_would_fetch", cited.length);

    // 6. re-source a FACT below the floor from a better capture
    const floor = authorityFloorFor(item.item_type);
    const corpusRows = item.source_url && !dry && claims.some((c) => claimNeedsResource(c, item, idx))
      ? await fetchAllRows<Capture & { intelligence_item_id: string }>((from, to) => sb.from("agent_run_searches").select("id, result_url, result_content, intelligence_item_id").in("result_url", [item.source_url as string, `${item.source_url}/`]).neq("intelligence_item_id", item.id).order("id", { ascending: true }).range(from, to) as never, { cap: 5_000 })
      : [];
    const buckets = buildBuckets(item, captures, idx, floor, corpusRows, itemSource?.base_tier ?? null);
    const resourceOutcome = new Map<string, string>();
    for (const c of claims.filter((x) => claimNeedsResource(x, item, idx))) {
      const p = planResource(c, buckets, cache);
      resourceOutcome.set(c.id, p.outcome);
      if (p.outcome === "resourced") { await repoint(c, buckets.find((b) => b.id === p.searchId) as Capture, p.newSpan, `resource:${p.bucket}`); bump("resourced"); }
    }

    // 7. re-kind what neither pass could prove: never a rewrite (a GAP or an ANALYSIS carries no source, tier or span the database would have to check)
    for (const c of claims.filter((x) => x.claim_kind === "FACT" && (groundOutcome.get(x.id) === "ungrounded_after_capture" || resourceOutcome.get(x.id) === "unresourced"))) {
      const plan = planReclassify(c, sections, required, item.source_url);
      if (plan.kind === "gap") {
        if (!dry) ops.push({ op: "claim", claim_id: c.id, row: { claim_kind: "GAP", claim_text: plan.claim_text, source_span: null, source_id: null, search_result_id: null }, note: "heal:reclassify" });
        Object.assign(c, { claim_kind: "GAP", claim_text: plan.claim_text, source_span: null, source_id: null, search_result_id: null });
        bump("reclassified_gap");
      } else if (plan.kind === "analysis") {
        if (!dry) ops.push({ op: "claim", claim_id: c.id, row: { claim_kind: "ANALYSIS", ...(plan.moved && plan.sectionId ? { section_row_id: plan.sectionId } : {}) }, note: "heal:reclassify" });
        Object.assign(c, { claim_kind: "ANALYSIS", ...(plan.moved && plan.sectionId ? { section_row_id: plan.sectionId } : {}) });
        bump("reclassified_analysis");
      } else { bump("reclassify_refused"); notes.push(`claim ${c.id} left as FACT: ${plan.reason}`); }
    }

    // 8. Gate A orphans: a sentence of a held capture that says what the brief says (buckets first), then source-and-rate; one with no such sentence is withheld (no_verbatim_span)
    const derived = await derivedCoveredTokens(sb, item.id);
    const facts = () => claims.filter((c) => c.claim_kind === "FACT").map((c) => ({ claim_text: c.claim_text, source_span: c.source_span ?? "" }));
    let orphans = scanGateA(item.full_brief, facts(), derived).orphans;
    for (const o of orphans) {
      const sentence = briefSentenceOf(o.token, item.full_brief);
      const p = planOrphan(o, sentence, buckets, cache);
      if (!p.found || dry) { if (p.found) bump("orphans_would_ground"); continue; }
      const sectionId = findOwningSection(o.token, sections)?.id ?? recordSection();
      const holder = captureById(p.searchId) ?? (buckets.find((b) => b.id === p.searchId) as Capture);
      ops.push({ op: "claim", claim_id: null, row: { section_row_id: sectionId, claim_text: sentence, claim_kind: "FACT", source_span: p.span, source_id: await sourceForCapture(holder.result_url ?? "", attr), search_result_id: p.searchId } });
      claims.push({ id: `pending:${ops.length}`, claim_kind: "FACT", claim_text: sentence as string, source_span: p.span, source_id: null, search_result_id: p.searchId, section_row_id: sectionId });
      bump("orphans_grounded");
    }
    orphans = scanGateA(item.full_brief, facts(), derived).orphans;
    const sourced = await sourceOrphans(ctx, orphans);
    steps.source = sourced.map((s) => `${s.token}: ${s.outcome}`);
    bump("orphans_sourced", sourced.filter((s) => s.outcome.startsWith("grounded")).length);
    const unprovable = scanGateA(item.full_brief, facts(), derived).orphans.map((o) => o.token);
    bump("orphans_unprovable", unprovable.length);
    if (unprovable.length) steps.withheld = unprovable.map((token) => ({ token, reason: NO_VERBATIM_SPAN }));

    // 9. the opt-in honest strip
    let restore: HealItemResult["restore"];
    if (unprovable.length) {
      const plan = planBriefHonest(item.full_brief, unprovable, claims.filter((c) => c.claim_kind === "FACT"), derived);
      steps.brief_honest = plan.outcome;
      if (plan.outcome === "accepted" && input.stripUnprovable && !dry) {
        ops.push({ op: "brief", full_brief: plan.newFullBrief });
        restore = { itemId: item.id, previous: plan.previous };
        item.full_brief = plan.newFullBrief;
        bump("brief_stripped");
      }
    }

    // 10. relabel: paragraphs that carry an ANALYSIS claim, and unlabelled modal assertions
    const relabel = (s: Sec, md: string): void => {
      setSectionText(s, md);
      bump("relabeled");
    };
    for (const c of claims.filter((x) => x.claim_kind === "ANALYSIS")) {
      const owning = sections.find((s) => s.id === c.section_row_id);
      const plan = owning ? planRelabelParagraph(owning.content_md ?? "", c.claim_text) : null;
      if (owning && plan) relabel(owning, plan.content_md);
      else if (owning && input.stripUnprovable) {
        const fb = planRelabelFromFullBrief(owning, c.claim_text, item.full_brief);
        if (fb) relabel(owning, fb.content_md);
      }
    }
    for (const s of sections.filter((x) => sectionNeedsRelabel(x, claims))) {
      const plan = planRelabelModal(s.content_md ?? "");
      if (plan) relabel(s, plan.content_md);
    }

    // The ledger changes of the pass, as ONE transaction: all of them or none.
    if (!dry && ops.length) {
      const applied = await applyLedgerOps(sb, item.id, ops, nowIso);
      steps.ledger = applied;
      bump("ledger_ops", ops.length);
    }

    // 11. the Gate A state, written before the re-derive so criterion 7 finds it current
    const row = buildGateARow({ itemId: item.id, fullBrief: item.full_brief, factClaims: facts(), derivedCovered: derived, nowIso });
    steps.gate_a = { orphan_count: row.orphan_count };
    if (!dry) { const g = await upsertGateAState(sb, row); if (g.error) throw new Error(`item_gate_a_state: ${g.error}`); }

    // 12. re-derive: validate, touch, read the fresh status; an archived-unreasoned item that now verifies is un-archived
    const v = must("validate_item_provenance", await sb.rpc("validate_item_provenance", { p_item_id: item.id }));
    const verdict = (Array.isArray(v.data) ? v.data[0] : v.data) as { valid?: boolean; failures?: unknown[] } | null;
    let status: string | null = item.provenance_status;
    if (!dry && verdict?.valid) {
      must("touch", await sb.from("intelligence_items").update({ updated_at: nowIso }).eq("id", item.id));
      const fresh = must("status read", await sb.from("intelligence_items").select("provenance_status").eq("id", item.id).maybeSingle());
      status = (fresh.data as { provenance_status?: string } | null)?.provenance_status ?? null;
      if (input.selection === "archived-unreasoned" && status === "verified" && item.is_archived) {
        must("un-archive", await sb.from("intelligence_items").update({ is_archived: false, archive_reason: null, archived_date: null }).eq("id", item.id));
        bump("unarchived");
      }
    }
    steps.rederive = dry ? (verdict?.valid ? "would_verify" : "still_failing") : status;
    bump(verdict?.valid && (dry || status === "verified") ? "verified" : "still_failing");

    // INV-R2b-1: after a heal every FACT's (source, tier, capture) resolves to the capture that holds its span; a claim that does not is named, never passed over.
    if (!dry) {
      const bad = must("attribution check", await sb.rpc("ledger_attribution_violations", { p_item_id: item.id }));
      const list = (Array.isArray(bad.data) ? bad.data : []) as { claim_id: string; reason: string }[];
      if (list.length) {
        bump("attribution_violations", list.length);
        steps.attribution = list.slice(0, 20);
        notes.push(`${list.length} FACT(s) whose attribution does not resolve to the capture holding their span: ${list.slice(0, 3).map((x) => `${x.claim_id} ${x.reason}`).join("; ")}`);
      }
      // The attempt is stamped on the item so the next sweep takes the items it has not tried (D:45): selection orders by updated_at.
      if (status !== "verified") must("attempt stamp", await sb.from("intelligence_items").update({ updated_at: nowIso }).eq("id", item.id));
    }
    return { ...runResult(counts.still_failing || counts.attribution_violations ? "partial" : "ok", counts, notes), itemId: item.id, status, steps, ...(restore ? { restore } : {}) };
  } catch (e) {
    return fail(e, item?.provenance_status ?? null);
  }
}

export interface HealSweepInput { dry?: boolean; limit?: number; stripUnprovable?: boolean; selection?: "quarantined" | "archived-unreasoned" | "ids"; ids?: string[] }
/** Heal a batch: the quarantined items (or archived-unreasoned ones, or named ids), one at a time; one item's failure never stops the rest. The registry is read once for the whole batch; the least recently attempted items come first. */
export async function healQuarantined(deps: HealDeps, input: HealSweepInput = {}): Promise<RunResult & { results: HealItemResult[] }> {
  const selection = input.selection ?? "quarantined";
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  let ids: string[];
  let registry: HealSource[];
  try {
    registry = deps.registry ?? (await readRegistry(deps.sb));
    if (selection === "ids") ids = (input.ids ?? []).slice(0, limit);
    else {
      let q = deps.sb.from("intelligence_items").select("id");
      q = selection === "quarantined" ? q.eq("provenance_status", "quarantined").eq("is_archived", false) : q.eq("is_archived", true).is("archive_reason", null);
      const r = await q.order("updated_at", { ascending: true, nullsFirst: true }).order("id", { ascending: true }).limit(limit);
      if (r.error) throw new Error(r.error.message);
      ids = ((r.data ?? []) as { id: string }[]).map((x) => x.id);
    }
  } catch (e) {
    return { ...runResult("failed", {}, [`selection failed: ${e instanceof Error ? e.message : String(e)}`]), results: [] };
  }
  const results: HealItemResult[] = [];
  const counts: Record<string, number> = { items: ids.length };
  const notes: string[] = [];
  for (const itemId of ids) {
    const r = await healItem({ ...deps, registry }, { itemId, ...(input.dry !== undefined ? { dry: input.dry } : {}), ...(input.stripUnprovable ? { stripUnprovable: true } : {}), selection });
    results.push(r);
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    if (r.outcome === "failed") {
      counts.failed = (counts.failed ?? 0) + 1;
      notes.push(`${itemId}: ${r.notes.at(-1) ?? "failed"}`);
    }
  }
  return { ...runResult(counts.failed ? "partial" : "ok", counts, notes), results };
}

/** Touch record items whose cached status is stale against the function (the trigger then re-derives it). The status itself is only ever written by the trigger. */
export async function rederiveStale(deps: HealDeps, input: { dry?: boolean; limit?: number } = {}): Promise<RunResult> {
  const dry = input.dry ?? true;
  const cand = await deps.sb.from("intelligence_items").select("id").eq("item_grade", "record").eq("is_archived", false).neq("provenance_status", "verified").order("id", { ascending: true }).limit(Math.min(input.limit ?? 200, 200));
  if (cand.error) return runResult("failed", {}, [`candidate read failed: ${cand.error.message}`]);
  const counts: Record<string, number> = { candidates: (cand.data ?? []).length, stale: 0, touched: 0, still_invalid: 0 };
  const notes: string[] = [];
  for (const { id } of (cand.data ?? []) as { id: string }[]) {
    const v = await deps.sb.rpc("validate_item_provenance", { p_item_id: id });
    if (v.error) { notes.push(`${id}: ${v.error.message}`); continue; }
    if (!((Array.isArray(v.data) ? v.data[0] : v.data) as { valid?: boolean } | null)?.valid) { counts.still_invalid = (counts.still_invalid ?? 0) + 1; continue; }
    counts.stale = (counts.stale ?? 0) + 1;
    if (dry) continue;
    const u = await deps.sb.from("intelligence_items").update({ updated_at: deps.now().toISOString() }).eq("id", id);
    if (u.error) notes.push(`${id}: touch failed: ${u.error.message}`);
    else counts.touched = (counts.touched ?? 0) + 1;
  }
  return runResult(notes.length ? "partial" : "ok", counts, notes);
}
