// Ported from old_repo/scripts/turns/apply-record-briefs.mjs (lines 98-330)
// Ported from old_repo/scripts/turns/apply-record-briefs.mjs (lines 438-440)
// Ported from old_repo/scripts/turns/apply-record-briefs.mjs (lines 504-807)
// Ported from old_repo/scripts/turns/apply-record-briefs.mjs (lines 1158-1170)
// Record briefs applied: a validated batch of session-authored full briefs written to record-grade stubs, no model and no fetch. The per-item steps are DATA (STEPS): generate (the injected-brief seam), section,
// ground (the entry's ledger REPLACES the stub's: the mint verifies a record item, so a non-replacing ground would answer "already verified" and the authored claims would never land; the replaced claims are archived to claim_versions first; the stored provenance_status is read back and reported whatever the verdict, a quarantine is never hidden), grow (the cited sources registered and credited), terms, the structured actions
// (a real write: the column exists), and the flywheel participation (discovery, forward events and the compliance deadline, obligations, entities and lineage; a failed step is a recorded defect flag). The batch then runs
// the unscoped flywheel over exactly the applied ids and flushes the public cache, in the same run (rule 17). The IO budget and the cooldown read the ledger. Every write is checked.
import { extractRecommendedActions } from "@/core/brief";
import { stripClaimLedgerBlocks } from "@/core/brief";
import { INTEL_ITEMS_TAG, itemTag } from "@/core/cache";
import { stripUrlMarkers } from "@/core/shared/url";
import type { Db } from "@/core/db";
import { runResult, worst, type RunResult } from "@/core/types/run-result";
import { recordBriefTerms } from "@/core/vocabulary";
import { corpusPass, tagPass, termPass } from "@/features/flywheel";
import { groundInjectedLedger, injectBrief, readAdoptedTerms, sectionBrief } from "@/features/intake";
import { runParticipation } from "@/features/intake/flywheel-participation";
import { recordItemChange } from "@/features/sources/change";
import { growSources } from "@/features/sources";
import { allRows, rowsByIds } from "@/core/db";

import { BUDGET_STOP_REASON, budgetBytes, POOL_REREADS, preflight } from "../../kit/budget";
import { applyEntries, isObj, itemPool, type ApplyOpts, type BatchDeps, type EntrySpec, type Item, type Obj } from "../../kit/session-batch";

import { validateRecordBriefEntry, type RecordLive, type RecordPlan } from "./validate";

export interface RecordOpts extends ApplyOpts {
  /** Regenerate an item that already holds a brief (a record stub needs no flag). */
  allowBriefOverwrite?: boolean;
  ioBudgetMb?: number;
  cooldownMinutes?: number;
}

interface StepCtx { deps: BatchDeps; itemId: string; entry: Obj; batch: string; overwrite: boolean; ok: Record<string, boolean>; provenance: string | null }
interface StepOut { outcome: string; ok: boolean; counts?: Record<string, number> }
type Step = (c: StepCtx) => Promise<StepOut>;
const intake = (c: StepCtx) => ({ sb: c.deps.sb, sources: c.deps.intake.sources, recorder: c.deps.intake.recorder });
const fromResult = (r: RunResult, ok = r.outcome !== "failed"): StepOut => ({ outcome: ok ? (r.notes[0] ?? r.outcome) : `failed: ${r.notes.slice(0, 2).join("; ")}`, ok });

/** The sources one entry cites: distinct claim urls and ids plus metadata.sources_used (an http(s) value is a url to register, a uuid an already registered source). */
export function collectEntryCitations(entry: Obj): { cited: { name: string; url: string }[]; citedSourceIds: string[] } {
  const urls = new Set<string>();
  const ids = new Set<string>();
  const take = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : "";
    if (/^https?:\/\//i.test(t)) urls.add(t);
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) ids.add(t.toLowerCase());
  };
  for (const c of Array.isArray(entry.claims) ? entry.claims : []) {
    if (!isObj(c)) continue;
    take(c.source_url);
    take(c.source_id);
  }
  for (const s of isObj(entry.metadata) && Array.isArray(entry.metadata.sources_used) ? entry.metadata.sources_used : []) take(s);
  return { cited: [...urls].map((url) => ({ name: url, url })), citedSourceIds: [...ids] };
}

const itemRow = async (db: Db, id: string) => {
  const r = await db.from("intelligence_items").select("source_id, full_brief, item_type, provenance_status").eq("id", id).maybeSingle();
  if (r.error) throw new Error(`item read failed: ${r.error.message}`);
  return r.data as { source_id: string | null; full_brief: string | null; item_type: string; provenance_status: string | null } | null;
};

/** The per-item steps, in order. A step that throws is that step's failure; the rest still run (the flywheel is independent of a quarantine). */
export const STEPS: ReadonlyArray<readonly [string, Step]> = [
  ["generate", async (c) => {
    const r = await injectBrief(intake(c), { itemId: c.itemId, body: String(c.entry.body), metadata: c.entry.metadata, sourcePoolHash: String(c.entry.source_pool_hash), allowBriefOverwrite: c.overwrite });
    return { outcome: r.ok ? "generated" : `generate_failed: ${r.detail}`, ok: r.ok };
  }],
  ["section", async (c) => fromResult(await sectionBrief(intake(c), c.itemId))],
  ["ground", async (c) => {
    const r = await groundInjectedLedger(intake(c), { itemId: c.itemId, ledger: c.entry.claims, replaceLedger: true, batchId: c.batch });
    c.provenance = (await itemRow(c.deps.sb, c.itemId))?.provenance_status ?? null;
    // The ground answers "already verified" without storing the ledger when the item is still verified after its brief was written: the entry's claims did not land, and that is a failed step, never a quiet success.
    const skipped = r.ok && r.detail === "already verified";
    return { outcome: skipped ? "ground_skipped: the item was still verified when its brief was written, so the authored ledger was not stored" : `${r.ok ? "grounded" : `ground_failed: ${r.detail}`}; provenance_status ${c.provenance ?? "unknown"}`, ok: r.ok && !skipped };
  }],
  ["grow", async (c) => {
    const it = await itemRow(c.deps.sb, c.itemId);
    if (!it?.source_id || !it.full_brief) return { outcome: "grow_failed: the item has no source or brief to grow from", ok: false };
    const { cited, citedSourceIds } = collectEntryCitations(c.entry);
    return fromResult(await growSources({ db: c.deps.sb, now: c.deps.now }, { citedSourceId: it.source_id, brief: it.full_brief, extra: { cited, citedSourceIds, intelligenceItemId: c.itemId } }));
  }],
  ["terms", async (c) => {
    const terms = isObj(c.entry.metadata) ? c.entry.metadata.mentioned_terms : null;
    if (!Array.isArray(terms) || !terms.length) return { outcome: "no mentioned terms", ok: true };
    const it = await itemRow(c.deps.sb, c.itemId);
    const sb = c.deps.sb;
    const r = await recordBriefTerms({ itemId: c.itemId, sourceId: it?.source_id ?? null, terms, now: c.deps.now().toISOString() }, {
      readTerms: async (keys) => {
        const { data, error } = await sb.from("vocabulary_terms").select("*").in("term_key", keys);
        if (error) throw new Error(`vocabulary_terms read failed: ${error.message}`);
        return (data ?? []) as never;
      },
      insertTerms: async (rows) => {
        const { data, error } = await sb.from("vocabulary_terms").insert(rows).select("id, kind, term_key");
        if (error) throw new Error(`vocabulary_terms insert failed: ${error.message}`);
        return { rows: (data ?? []) as { id: string; kind: string; term_key: string }[] };
      },
      upsertMentions: async (rows) => {
        const { error } = await sb.from("vocabulary_mentions").upsert(rows, { onConflict: "term_id,item_id,detector" });
        if (error) throw new Error(`vocabulary_mentions upsert failed: ${error.message}`);
      },
    });
    return { outcome: `${r.mentions_written} mention(s), ${r.terms_inserted} new term(s), ${r.skipped_retired} retired skipped`, ok: true, counts: { terms_mentions: r.mentions_written } };
  }],
  ["structured-actions", async (c) => {
    const it = await itemRow(c.deps.sb, c.itemId);
    if (!it?.full_brief) return { outcome: "structured-actions: no brief to read", ok: false };
    const actions = extractRecommendedActions(it.full_brief, it.item_type);
    const { error } = await c.deps.sb.from("intelligence_items").update({ recommended_actions: actions }).eq("id", c.itemId);
    return error ? { outcome: `structured-actions_failed: ${error.message}`, ok: false } : { outcome: `${actions.length} action(s) written`, ok: true, counts: { actions_written: actions.length } };
  }],
  ["participation", async (c) => {
    const r = await runParticipation({ sb: c.deps.sb, connect: c.deps.intake.connect, now: c.deps.now }, { itemId: c.itemId, context: "update", changed: ["full_brief", "jurisdiction_iso"] });
    return { outcome: r.flags.join(",") || "no new links", ok: r.outcome === "ok", counts: { participation_flags: r.flags.length } };
  }],
];
export const APPLY_STEP_NAMES: readonly string[] = STEPS.map(([n]) => n);

/** The customer-visible change a verified regeneration is, once per (item, batch). */
async function recordRegeneration(c: StepCtx): Promise<string | null> {
  const seen = await c.deps.sb.from("intelligence_changes").select("id").eq("item_id", c.itemId).contains("new_value", { batch: c.batch }).limit(1);
  if (seen.error) return `change read failed: ${seen.error.message}`;
  if ((seen.data ?? []).length) return null;
  const r = await recordItemChange(c.deps.sb, { itemId: c.itemId, previous: { full_brief: c.overwrite ? "stored" : null }, next: { full_brief: "regenerated", batch: c.batch }, changeTypeOverride: "provision_amended" });
  return r.ok ? null : `change not recorded: ${r.error}`;
}

async function applyItem(deps: BatchDeps, item: Item<RecordPlan>, batch: string, overwrite: boolean) {
  const ctx: StepCtx = { deps, itemId: item.plan.itemId, entry: item.entry, batch, overwrite, ok: {}, provenance: null };
  const failed: string[] = [];
  const counts: Record<string, number> = {};
  for (const [name, run] of STEPS) {
    try {
      const r = await run(ctx);
      ctx.ok[name] = r.ok;
      for (const [k, n] of Object.entries(r.counts ?? {})) counts[k] = (counts[k] ?? 0) + n;
      if (!r.ok) failed.push(`${item.plan.itemId} ${name}: ${r.outcome}`);
    } catch (e) {
      ctx.ok[name] = false;
      failed.push(`${item.plan.itemId} ${name}: threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!ctx.ok.generate) throw new Error(failed[0] ?? "generate failed");
  if (ctx.ok.generate && ctx.ok.section && ctx.ok.ground && ctx.provenance === "verified") {
    const note = await recordRegeneration(ctx).catch((e: Error) => e.message);
    if (note) failed.push(`${item.plan.itemId} changelog: ${note}`);
    else counts.changes_recorded = 1;
  }
  if (ctx.provenance && ctx.provenance !== "verified") counts.quarantined = 1;
  else if (ctx.provenance === "verified") counts.verified = 1;
  return { ref: item.plan.itemId, notes: failed, counts };
}

/** The unscoped flywheel over exactly the applied ids (tags, terms, then the corpus pass), and the public cache flush. */
async function afterBatch(deps: BatchDeps, ids: string[], o: ApplyOpts): Promise<RunResult> {
  const parts: RunResult[] = [];
  const guard = async (what: string, f: () => Promise<RunResult>) => {
    try {
      parts.push(await f());
    } catch (e) {
      parts.push(runResult("failed", {}, [`${what} threw: ${e instanceof Error ? e.message : String(e)}`]));
    }
  };
  const d = { sb: deps.sb, now: deps.now };
  await guard("tag pass", () => tagPass(d, { ids, dry: false }));
  await guard("term pass", () => termPass(d, { dry: false }));
  await guard("corpus pass", () => corpusPass({ ...d, ...(o.runId ? { runId: o.runId } : {}) }, { dry: false }));
  const notes = parts.flatMap((p) => p.notes);
  let flushed = 0;
  if (deps.flushCache) {
    const f = await deps.flushCache([INTEL_ITEMS_TAG, ...ids.map(itemTag)]);
    if (f.error) notes.push(`cache flush: ${f.error}`);
    else flushed = 1;
  } else notes.push("cache flush owed: no flush is wired in this run");
  return runResult(worst("ok", ...parts.map((p) => p.outcome), flushed ? "ok" : "partial"), { flywheel_passes: parts.length, cache_flushed: flushed }, notes);
}

export function recordBriefsSpec(opts: RecordOpts): EntrySpec<RecordLive, RecordPlan> {
  return {
    kind: "record-briefs",
    batchRe: /^record-briefs-[A-Za-z0-9._-]+$/,
    ceiling: 200,
    keyOf: (e) => (typeof e.item_id === "string" ? e.item_id : null),
    async load(deps, file) {
      const ids = [...new Set((file.entries as unknown[]).map((e) => (isObj(e) && typeof e.item_id === "string" ? e.item_id : "")).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
      const rows = await rowsByIds<{ id: string; item_type: string; item_grade: string | null; provenance_status: string | null; full_brief: string | null }>(deps.sb, "intelligence_items", "id, item_type, item_grade, provenance_status, full_brief", ids);
      const items: RecordLive["items"] = new Map();
      for (const r of rows) {
        const p = await itemPool(deps.sb, r.id);
        items.set(r.id, { itemType: r.item_type, grade: r.item_grade, status: r.provenance_status, hash: p.hash, poolText: p.pool.map((x) => x.text).join("\n\n"), bytes: p.bytes, fullBrief: r.full_brief });
      }
      const slotRows = await allRows<{ item_type: string; slot_key: string; description: string | null }>(deps.sb, "item_type_required_slots", "item_type, slot_key, description", { cap: 5000 });
      const slots: RecordLive["slots"] = new Map();
      for (const s of slotRows) slots.set(s.item_type, [...(slots.get(s.item_type) ?? []), { slot_key: s.slot_key, description: s.description }]);
      return { items, slots, adopted: (await readAdoptedTerms(deps.sb)).adopted, now: deps.now(), allowOverwrite: opts.allowBriefOverwrite === true };
    },
    entry: (e, i, live) => {
      const done = isObj(e) && typeof e.item_id === "string" && typeof e.body === "string" ? sameBrief(live.items.get(e.item_id)?.fullBrief, e.body) && live.items.get(e.item_id)?.grade === "brief" : false;
      return done ? { errors: [], done: true } : validateRecordBriefEntry(e, i, live);
    },
    write: (deps, _live, item, batch) => applyItem(deps, item, batch, opts.allowBriefOverwrite === true),
    cost: (item) => item.plan.bytes * POOL_REREADS,
    async readBack(deps, _live, written) {
      const rows = await rowsByIds<{ id: string; item_grade: string | null; full_brief: string | null }>(deps.sb, "intelligence_items", "id, item_grade, full_brief", written.map((w) => w.plan.itemId));
      const ok = new Set(rows.filter((r) => r.item_grade === "brief" && !!r.full_brief).map((r) => r.id));
      return written.filter((w) => !ok.has(w.plan.itemId)).map((w) => w.plan.itemId);
    },
    downstream: (deps, _live, written, o) => afterBatch(deps, written.map((w) => w.plan.itemId), o),
    guard: (deps, o) => preflight(deps, { ...(o.runId ? { runId: o.runId } : {}), ...(opts.cooldownMinutes !== undefined ? { cooldownMinutes: opts.cooldownMinutes } : {}) }),
  };
}

/** The body as the write site stores it (hygiene applied), so a re-apply of the same batch is recognised as already applied. */
const stored = (s: string | null | undefined): string => stripClaimLedgerBlocks(stripUrlMarkers(String(s ?? "").trim()) ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
export const sameBrief = (storedBrief: string | null | undefined, body: string): boolean => !!storedBrief && stored(storedBrief) === stored(body);

/** Apply one record-briefs batch (the budget and the window arrive as options; the cooldown reads the ledger). */
export async function applyRecordBriefs(deps: BatchDeps, file: unknown, o: RecordOpts): Promise<RunResult> {
  const opts: RecordOpts = { ...o, budgetBytes: o.budgetBytes ?? budgetBytes(o.ioBudgetMb) };
  const r = await applyEntries(recordBriefsSpec(opts), deps, file, opts);
  if (r.counts.not_applied_io_budget) r.notes.push(`stop_reason=${BUDGET_STOP_REASON}`);
  return r;
}
