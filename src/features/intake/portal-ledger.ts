// Ported from old_repo/src/lib/intake/portal-harvest.ts (lines 8-43)
// Ported from old_repo/src/lib/intake/portal-harvest.ts (lines 47-117)
// Ported from old_repo/src/lib/intake/portal-harvest.ts (lines 191-324)
// Ported from old_repo/src/lib/intake/portal-harvest.ts (lines 326-533)
// Ported from old_repo/src/lib/intake/promote-cap.mjs (lines 1-18)
// The portal link ledger: persist discovered deep links, read one keyset page, and consume it (verdict -> dry mint -> capped promote).
// Differences from the old module, each a closed defect: the persist is BATCHED (one checked upsert per chunk, not one round trip per
// link); the page read is the RPC alone (its server-side census anti-join replaced the client NOT IN list that overflowed PostgREST,
// and the pre-migration fallback is gone); the classification is the session verdict file (no model call); every ledger stamp is
// CHECKED and a failed stamp is reported (the row stays a candidate); a read error throws a LookupError, never an empty page.
import { LookupError } from "@/core/http/errors";
import { validateClassifyVerdict, type ClassifyVerdict } from "@/core/intake/classify-verdict";
import { runResult, type RunResult } from "@/core/intake/result";
import { toDbSeverity } from "@/core/brief/vocab";
import type { Db } from "@/core/db";

import { runIntakeCycle, type IntakeCandidate, type CycleResult } from "./cycle";
import type { IntakeDeps } from "./deps";
import { applyStagedUpdate } from "./staged-transit";
import type { InjectedBrief } from "./workflow";

export interface PortalLink { url: string; anchorText?: string | null }
export const PERSIST_CHUNK = 200;

/** Upsert discovered links (one row per URL ever; a re-crawl refreshes last_seen_at and anchor_text and never touches status or dispositions). */
export async function persistPortalCandidates(sb: Db, sourceId: string, links: PortalLink[], nowIso: string): Promise<RunResult & { upserted: number; failed: number }> {
  const unique = new Map<string, PortalLink>();
  for (const l of links) if (l.url) unique.set(l.url, l);
  const rows = [...unique.values()].map((l) => ({ source_id: sourceId, url: l.url, anchor_text: l.anchorText ?? null, last_seen_at: nowIso }));
  let upserted = 0;
  let failed = 0;
  const notes: string[] = [];
  for (let i = 0; i < rows.length; i += PERSIST_CHUNK) {
    const chunk = rows.slice(i, i + PERSIST_CHUNK);
    const { error } = await sb.from("portal_link_candidates").upsert(chunk, { onConflict: "url" });
    if (error) {
      failed += chunk.length;
      notes.push(`candidate upsert failed for ${chunk.length} link(s) from ${chunk[0]?.url}: ${error.message}`);
    } else upserted += chunk.length;
  }
  return { ...runResult(failed ? (upserted ? "partial" : "failed") : "ok", { upserted, failed, duplicates: links.length - rows.length }, notes), upserted, failed };
}

export interface LedgerCandidate { id: string; url: string; anchor_text: string | null; source_id: string; first_seen_at: string; sources: { name: string | null; category: string | null; base_tier: number | null } | null }
export interface LedgerCursor { firstSeenAt: string; id: string }
export interface PageOpts { limit: number; sourceId?: string; newestFirst?: boolean; after?: LedgerCursor | null }

/** One keyset page of candidates in (first_seen_at, id) order, census-excluded server side. A failed read throws; it is never an empty page. */
export async function selectCandidateLedgerPage(sb: Db, opts: PageOpts): Promise<LedgerCandidate[]> {
  const { data, error } = await sb.rpc("next_uncensused_portal_candidates", { p_source_id: opts.sourceId ?? null, p_limit: opts.limit, p_newest: !!opts.newestFirst, p_after_first_seen: opts.after?.firstSeenAt ?? null, p_after_id: opts.after?.id ?? null });
  if (error) throw new LookupError("next_uncensused_portal_candidates", error);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ id: r.id as string, url: r.url as string, anchor_text: (r.anchor_text ?? null) as string | null, source_id: r.source_id as string, first_seen_at: r.first_seen_at as string, sources: { name: (r.source_name ?? null) as string | null, category: (r.source_category ?? null) as string | null, base_tier: (r.source_base_tier ?? null) as number | null } }));
}

/** items.slice(0, cap) is promoted, the rest deferred untouched. A non-finite or negative cap means no cap. */
export function applyPromoteCap<T>(items: T[], cap: number): { toPromote: T[]; deferred: T[] } {
  const n = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : items.length;
  return { toPromote: items.slice(0, n), deferred: items.slice(n) };
}

/** The one place a verdict maps to the seed vocabulary; toDbSeverity throws on a vocabulary break (the row is then skipped, loudly). */
export function buildCandidateSeed(row: LedgerCandidate, cls: ClassifyVerdict, capturedText?: string): IntakeCandidate {
  return { title: cls.title_candidate, source_url: row.url, item_type: cls.item_type as string, domain: cls.domain, severity: toDbSeverity(cls.severity), priority: cls.priority, urgency_tier: cls.urgency_tier, topic_tags: cls.topic_tags, jurisdictions: cls.jurisdictions, summary: cls.summary, relevance: cls.relevance, source_id: row.source_id, ...(capturedText ? { capturedText } : {}) };
}

export type CandidateDisposition = "would_mint" | "would_reject" | "exists" | "not_an_item" | "promoted" | "rejected" | "skipped";
export interface CandidateOutcome { ledgerId: string; url: string; disposition: CandidateDisposition; reason: string; itemId?: string | null; itemType?: string | null; title?: string | null; surfaceTags?: string[] }
export interface ConsumeOpts extends PageOpts {
  mode: "plan" | "apply";
  caller?: string | null;
  /** The session verdict file's entries by URL: a row with no verdict is skipped BEFORE any fetch (no fetch is spent on what cannot be classified). */
  verdicts: ReadonlyMap<string, unknown>;
  /** Fetch the page text for the record-grade pool row. Default true; a fetch the sources slice disallows (build mode) is skipped, not failed. */
  fetch?: boolean;
  recordOnly?: boolean;
  maxPromote?: number;
  briefFor?: (candidate: IntakeCandidate, itemId: string) => Promise<InjectedBrief | null>;
}
export type ConsumeResult = RunResult & { mode: "plan" | "apply"; discovered: number; fetched: number; classified: number; outcomes: CandidateOutcome[]; cycle?: CycleResult; nextCursor?: LedgerCursor };

export async function consumePortalCandidates(deps: IntakeDeps, opts: ConsumeOpts): Promise<ConsumeResult> {
  const { sb, sources, recorder } = deps;
  const apply = opts.mode === "apply";
  const notes: string[] = [];
  const outcomes: CandidateOutcome[] = [];
  let candidates: LedgerCandidate[];
  try {
    candidates = await selectCandidateLedgerPage(sb, opts);
  } catch (e) {
    return { ...runResult("failed", {}, [e instanceof Error ? e.message : String(e)]), mode: opts.mode, discovered: 0, fetched: 0, classified: 0, outcomes };
  }
  let stampFailed = 0;
  const stamp = async (row: LedgerCandidate, status: "promoted" | "rejected", reason: string, itemId: string | null) => {
    if (!apply) return;
    const { error } = await sb.from("portal_link_candidates").update({ status, disposition_reason: reason.slice(0, 900), dispositioned_at: recorder.now().toISOString(), item_id: itemId }).eq("id", row.id);
    if (error) {
      stampFailed += 1;
      notes.push(`ledger stamp failed for ${row.url} (the row stays a candidate): ${error.message}`);
    }
  };
  const skip = (row: LedgerCandidate, reason: string) => outcomes.push({ ledgerId: row.id, url: row.url, disposition: "skipped", reason });
  let fetched = 0;
  let classified = 0;
  const mintable: { row: LedgerCandidate; seed: IntakeCandidate; surfaceTags: string[] }[] = [];

  for (const row of candidates) {
    const verdict = opts.verdicts.get(row.url);
    if (verdict === undefined) {
      skip(row, "skipped-no-verdict: no session verdict for this URL");
      continue;
    }
    let text = "";
    if (opts.fetch !== false && sources.fetchAllowed(row.url, opts.caller ?? null)) {
      try {
        const cap = await sources.capture(row.url, { family: "portal-ledger", key: row.id });
        if (cap.wall) {
          skip(row, `access_wall:${cap.wall.kind}`);
          continue;
        }
        if (!cap.ok || cap.text.trim().length < 200) {
          skip(row, cap.ok ? `fetch inconclusive: ${cap.text.trim().length}ch (<200ch floor)` : `fetch failed: ${cap.reason ?? "no body"}`);
          continue;
        }
        text = cap.text;
        fetched += 1;
      } catch (e) {
        skip(row, `fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    const v = validateClassifyVerdict({ source_id: row.source_id, source_url: row.url, source_name: row.anchor_text || row.sources?.name || null, source_tier: row.sources?.base_tier ?? null, source_category: (row.sources?.category ?? null) as never, text }, verdict, { isErrorBody: (t) => (t ? sources.classifyBody(t).errorBody : false) });
    if (!v.ok) {
      skip(row, `verdict invalid: ${v.error}`);
      continue;
    }
    classified += 1;
    const cls = v.result;
    if (cls.entity_verdict !== "specific_document" || !cls.item_type) {
      const reason = `entity-gate: ${cls.entity_verdict}, ${cls.rationale || "not a specific document"}`;
      await stamp(row, "rejected", reason, null);
      outcomes.push({ ledgerId: row.id, url: row.url, disposition: "not_an_item", reason, title: cls.title_candidate, surfaceTags: cls.surface_tags });
      continue;
    }
    let seed: IntakeCandidate;
    try {
      seed = buildCandidateSeed(row, cls, text || undefined);
    } catch (e) {
      skip(row, `seed vocabulary: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const { capturedText: _carrier, ...stagedFields } = seed;
    void _carrier;
    const dry = await applyStagedUpdate(deps, { update_type: "new_item", item_id: null, proposed_changes: stagedFields }, { dry: true });
    if (dry.success && dry.action === "exists" && dry.itemId) {
      const reason = `exists: subject already minted as ${dry.itemId} (idempotent, no re-ground)`;
      await stamp(row, "promoted", reason, dry.itemId);
      outcomes.push({ ledgerId: row.id, url: row.url, disposition: "exists", reason, itemId: dry.itemId, itemType: seed.item_type, title: seed.title, surfaceTags: cls.surface_tags });
      continue;
    }
    if (!dry.success) {
      const reason = `${dry.action ? `chokepoint:${dry.action}` : "entity-gate"}: ${dry.error ?? "rejected"}`;
      await stamp(row, "rejected", reason, null);
      outcomes.push({ ledgerId: row.id, url: row.url, disposition: apply ? "rejected" : "would_reject", reason, itemType: seed.item_type, title: seed.title, surfaceTags: cls.surface_tags });
      continue;
    }
    if (!apply) {
      outcomes.push({ ledgerId: row.id, url: row.url, disposition: "would_mint", reason: `dry: ${dry.action ?? "minted"}${dry.flags?.length ? ` [${dry.flags.join(",")}]` : ""}`, itemType: seed.item_type, title: seed.title, surfaceTags: cls.surface_tags });
      continue;
    }
    mintable.push({ row, seed, surfaceTags: cls.surface_tags });
  }

  let cycle: CycleResult | undefined;
  if (apply && mintable.length) {
    const cap = typeof opts.maxPromote === "number" ? opts.maxPromote : mintable.length;
    const { toPromote, deferred } = applyPromoteCap(mintable, cap);
    for (const d of deferred) outcomes.push({ ledgerId: d.row.id, url: d.row.url, disposition: "skipped", reason: `capped: max_promote=${cap} reached, row left as 'candidate' for a later apply run`, itemType: d.seed.item_type, title: d.seed.title, surfaceTags: d.surfaceTags });
    if (toPromote.length) {
      cycle = await runIntakeCycle(deps, { candidates: toPromote.map((m) => m.seed), mode: "apply", ...(opts.caller ? { caller: opts.caller } : {}), ...(opts.recordOnly !== undefined ? { recordOnly: opts.recordOnly } : {}), ...(opts.briefFor ? { briefFor: opts.briefFor } : {}) });
      notes.push(...cycle.notes);
      for (const m of toPromote) {
        const item = cycle.items.find((i) => i.source_url === m.seed.source_url);
        if (!item) continue;
        const base = { ledgerId: m.row.id, url: m.row.url, itemType: m.seed.item_type, title: m.seed.title, surfaceTags: m.surfaceTags };
        if (item.itemId) {
          const reason = `minted (${item.disposition})${item.reason ? `: ${item.reason}` : ""}`;
          await stamp(m.row, "promoted", reason, item.itemId);
          outcomes.push({ ...base, disposition: "promoted", reason, itemId: item.itemId });
        } else if (item.disposition === "rejected") {
          const reason = `${item.gate ?? "chokepoint"}: ${item.reason ?? "rejected"}`;
          await stamp(m.row, "rejected", reason, null);
          outcomes.push({ ...base, disposition: "rejected", reason });
        } else outcomes.push({ ...base, disposition: "skipped", reason: `${item.disposition}: ${item.reason ?? ""}` });
      }
    }
  }
  const last = candidates[candidates.length - 1];
  const nextCursor = candidates.length === opts.limit && last ? { firstSeenAt: last.first_seen_at, id: last.id } : undefined;
  const counts = { discovered: candidates.length, fetched, classified, outcomes: outcomes.length, stamp_failed: stampFailed };
  return { ...runResult(stampFailed || cycle?.outcome === "partial" ? "partial" : cycle?.outcome === "failed" ? "failed" : "ok", counts, notes), mode: opts.mode, discovered: candidates.length, fetched, classified, outcomes, ...(cycle ? { cycle } : {}), ...(nextCursor ? { nextCursor } : {}) };
}
