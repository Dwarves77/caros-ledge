// Ported from old_repo/scripts/mint/apply-mint-batch.mjs (lines 98-120)
// Ported from old_repo/scripts/mint/apply-mint-batch.mjs (lines 298-494)
// Ported from old_repo/scripts/mint/reopen-validation-holds.mjs (lines 27-97)
// The guarded apply of one built payload: register-and-rate the source if needed (rule 18: the tier is the class table's, never defaulted), derive the domain, hand the
// payload to the ONE mint function (M4 and every gate run there, at insert), then read the verdict back from the ROW (population run #8: never from the RPC's own valid
// flag). The census row is stamped `reconciled` only for a verified mint (B-2186); every other outcome is a hold with a stage-qualified reason, written to the census row
// and CHECKED (the old holds lived in a scratch file, so held rows were re-fetched every run). A reopen needs a stated reason (INV-028).
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { domainForItemType } from "@/core/shared/domains";
import { registerAndRate } from "@/core/sources";
import { classifyMintOutcome } from "@/features/intake/write-item";

import { mintItem, type MintCtx, type MintDetail } from "./mint-item";
import { HOLD_STAGES, type Hold, type SourceRow } from "./types";
import type { BuiltPayload } from "./build-payload";

export type ApplyOutcome = "minted_verified" | "minted_unverified" | "would_mint" | "refused" | "failed";
export interface ApplyResult {
  censusId: string;
  outcome: ApplyOutcome;
  itemId: string | null;
  hold: Hold | null;
  reasons: string[];
  detail?: MintDetail;
  notes: string[];
}
// INV-175: the grounding tier of a source is its base_tier; an override or a reputation score never confers grounding eligibility.
const tierOf = (s: Pick<SourceRow, "base_tier">): number | null => s.base_tier ?? null;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The item row for a payload (provenance_status is never written here: the trigger derives it, depth-1, for a new row). */
function buildItemRow(payload: BuiltPayload["payload"], c: { sourceId: string; domain: number }): Record<string, unknown> {
  const i = payload.item as Record<string, unknown>;
  return {
    title: i.title, domain: c.domain, item_type: i.item_type, source_id: c.sourceId, source_url: i.source_url, priority: i.priority ?? "MODERATE", full_brief: i.full_brief,
    instrument_identifier: i.instrument_identifier ?? null, canonical_instrument_key: i.canonical_instrument_key ?? null, jurisdiction_iso: i.jurisdiction_iso ? [i.jurisdiction_iso] : [], item_grade: i.grade ?? "record",
  };
}

/** The fresh verdict of the item's own row, plus the function's failures for the hold evidence. Read errors are returned as notes, never swallowed. */
async function readBack(sb: Db, itemId: string): Promise<{ status: string | null; failures: { criterion?: unknown; reason?: unknown }[]; notes: string[] }> {
  const notes: string[] = [];
  const rpc = await sb.rpc("validate_item_provenance", { p_item_id: itemId });
  if (rpc.error) notes.push(`validate_item_provenance failed for ${itemId}: ${rpc.error.message}`);
  const v = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as { failures?: { criterion?: unknown; reason?: unknown }[] } | null;
  const row = await sb.from("intelligence_items").select("provenance_status").eq("id", itemId).maybeSingle();
  if (row.error) notes.push(`provenance read-back failed for ${itemId}: ${row.error.message}`);
  return { status: (row.data as { provenance_status?: string } | null)?.provenance_status ?? null, failures: v?.failures ?? [], notes };
}

export async function applyPayload(built: BuiltPayload, source: SourceRow, ctx: MintCtx, opts: { dry: boolean }): Promise<ApplyResult> {
  const { censusId, payload } = built;
  const base = { censusId, itemId: null, hold: null, reasons: [] as string[], notes: [] as string[] };
  const refuse = (reason: string, evidence?: Record<string, unknown>): ApplyResult => ({ ...base, outcome: "refused", hold: { rowId: censusId, reason, ...(evidence ? { evidence } : {}) }, reasons: [reason] });
  const url = source.url ?? (payload.item.source_url as string);

  let sourceId = source.id;
  let tier = tierOf(source);
  if (source.status !== "active" || tier == null) {
    if (opts.dry) base.reasons.push("source:would_register");
    else {
      try {
        const reg = await registerAndRate(ctx.sb, url, { name: source.name });
        if (reg.status === "worklist" || reg.status === "refused") return refuse(`source:${reg.status}:${reg.reason.slice(0, 120)}`, { host: reg.host });
        sourceId = reg.source_id;
        tier = reg.tier;
      } catch (e) {
        return { ...base, outcome: "failed", reasons: [`source registration failed: ${msg(e)}`] };
      }
    }
  }
  const domain = domainForItemType(payload.item.item_type as string, source.category as never);
  if (domain == null) return refuse(`identity:domain_unresolved:${String(payload.item.item_type)}`);

  const detail = await mintItem({ seed: buildItemRow(payload, { sourceId, domain }), origin: "mint", grade: "record", payload, sourceTier: tier }, ctx, opts);
  const common = { ...base, detail, reasons: [...base.reasons, ...detail.reasons] };
  if (detail.outcome === "exists" || detail.outcome === "duplicate") return { ...common, outcome: "refused", itemId: detail.itemId, hold: { rowId: censusId, reason: `held:${detail.outcome}:${detail.itemId ?? "unknown"}`, evidence: { reasons: detail.reasons } } };
  if (detail.outcome === "unsourced") return { ...common, outcome: "refused", hold: { rowId: censusId, reason: "source:unsourced", evidence: { reasons: detail.reasons } } };
  if (detail.outcome === "rejected") return { ...common, outcome: "failed", itemId: detail.itemId };
  if (opts.dry) return { ...common, outcome: "would_mint" };

  const itemId = detail.itemId as string;
  const rb = await readBack(ctx.sb, itemId);
  const verified = classifyMintOutcome(rb.status) === "minted_verified";
  const f = rb.failures[0];
  return {
    ...common, itemId, notes: rb.notes, outcome: verified ? "minted_verified" : "minted_unverified",
    hold: verified ? null : { rowId: censusId, reason: `validation_failed:${String(f?.criterion ?? "rpc")}:${String(f?.reason ?? "unknown")}`, evidence: { provenance_status: rb.status, failures: rb.failures } },
  };
}

// ---- census dispositions (every write checked) ---------------------------------------------------------------------------------------------------------------------

/** Record a hold on the census row. A write failure comes back as a note: the row would otherwise be re-selected unchanged next run. */
export async function holdRow(sb: Db, hold: Hold, nowIso: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  const notes = JSON.stringify({ held_by: "mint", held_at: nowIso, ...extra, evidence: hold.evidence ?? null }).slice(0, 8000);
  const { error } = await sb.from("census_worklist").update({ dryrun_disposition: "hold", hold_reason: hold.reason.slice(0, 480), notes }).eq("id", hold.rowId);
  return error ? `census hold for ${hold.rowId} (${hold.reason}) not written: ${error.message}` : null;
}
/** Stamp the census row reconciled: only a verified mint reaches here. */
export async function reconcileRow(sb: Db, rowId: string): Promise<string | null> {
  const { error } = await sb.from("census_worklist").update({ enumeration_status: "reconciled" }).eq("id", rowId);
  return error ? `census reconcile for ${rowId} not written: ${error.message}` : null;
}

const STAGE_RE = new RegExp(`^(${HOLD_STAGES.join("|")}):`);
/** Pure: does this row's hold match the reopen scope? Only a mint-written hold, and only for a reason the caller named (an empty reason matches nothing). */
export function isReopenTarget(row: { dryrun_disposition?: string | null; hold_reason?: string | null }, reasonContains: string): boolean {
  if (row.dryrun_disposition !== "hold" || !reasonContains.trim()) return false;
  const reason = row.hold_reason;
  return typeof reason === "string" && STAGE_RE.test(reason) && reason.toLowerCase().includes(reasonContains.toLowerCase());
}

/** Re-admit held rows whose reason contains the stated text to would_mint, keeping the held evidence and appending the reopen marker. No re-validation here: the next run decides. */
export async function reopenHeldRows(sb: Db, reasonContains: string, opts: { dry: boolean; nowIso: string }): Promise<{ matched: number; written: number; failures: string[] }> {
  if (!reasonContains.trim()) throw new Error("reopen: a stated reason is required, never a blanket reopen");
  const rows = await fetchAllRows<{ id: string; dryrun_disposition: string | null; hold_reason: string | null; notes: string | null }>((from, to) => sb.from("census_worklist").select("id, dryrun_disposition, hold_reason, notes").eq("dryrun_disposition", "hold").order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 });
  const targets = rows.filter((r) => isReopenTarget(r, reasonContains));
  const failures: string[] = [];
  let written = 0;
  if (opts.dry) return { matched: targets.length, written, failures };
  for (const t of targets) {
    const marker = `[reopened ${opts.nowIso}] matched ${JSON.stringify(reasonContains)}; re-admitted to would_mint, not re-validated here.`;
    const { error } = await sb.from("census_worklist").update({ dryrun_disposition: "would_mint", hold_reason: null, notes: t.notes ? `${t.notes}\n\n${marker}` : marker }).eq("id", t.id).eq("dryrun_disposition", "hold");
    if (error) failures.push(`${t.id}: ${error.message}`);
    else written += 1;
  }
  return { matched: targets.length, written, failures };
}
