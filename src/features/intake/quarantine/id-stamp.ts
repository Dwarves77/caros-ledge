// Ported from old_repo/scripts/_reground/id-stamp.mjs (lines 19-66)
// Ported from old_repo/scripts/lib/mutation-lease.mjs (lines 1-24)
// Stamp a canonical instrument identifier once the target-match IDENTIFIER-CONFIRMS the item's own stored capture, under the item's
// mutation lease (INV-101: no lease, no touch). The item is found by a KEYED lookup (full id or legacy_id; a legacy_id prefix must be
// unambiguous), never by reading the whole table. "Id-confirmed" means the match verdict is `match` AND the proposed identifier is
// itself verbatim in the capture (the one verbatim rule): a subject-overlap match alone never promotes an item.
import { isVerbatim } from "@/core/contracts/verbatim";
import { boundedRead, type Db } from "@/core/db";
import { readPool } from "@/core/grounding/pool";
import type { TargetMatch } from "@/core/grounding/ground";
import { isUuid } from "@/core/http/parse";
import { runResult, type RunResult } from "@/core/intake/result";

import type { SourcesDeps } from "../deps";

// ---- the mutation lease (rpc-backed; the server owns the clock) ----
type LeaseRpc = { data: unknown; error: { message: string } | null };
const first = (d: unknown) => (Array.isArray(d) ? d[0] : d) as Record<string, unknown> | null;
export async function acquireLease(sb: Db, itemId: string, holder: string, lane: string | null = null, staleSeconds = 300): Promise<{ acquired: boolean; curHolder: string | null }> {
  const { data, error } = (await sb.rpc("acquire_mutation_lease", { p_item: itemId, p_holder: holder, p_lane: lane, p_stale_seconds: staleSeconds })) as LeaseRpc;
  if (error) throw new Error(`acquire_mutation_lease failed (${itemId}): ${error.message}`);
  const r = first(data);
  return { acquired: r?.acquired === true, curHolder: (r?.cur_holder as string | null) ?? null };
}
export async function heartbeatLease(sb: Db, itemId: string, holder: string): Promise<boolean> {
  const { data, error } = (await sb.rpc("heartbeat_mutation_lease", { p_item: itemId, p_holder: holder })) as LeaseRpc;
  if (error) throw new Error(`heartbeat_mutation_lease failed (${itemId}): ${error.message}`);
  return first(data)?.still_held === true;
}
export async function releaseLease(sb: Db, itemId: string, holder: string): Promise<boolean> {
  const { data, error } = (await sb.rpc("release_mutation_lease", { p_item: itemId, p_holder: holder })) as LeaseRpc;
  if (error) throw new Error(`release_mutation_lease failed (${itemId}): ${error.message}`);
  return first(data)?.released === true;
}

export interface KeyedItem { id: string; legacy_id: string | null; title: string | null; item_type: string; instrument_type: string | null; instrument_identifier: string | null; canonical_instrument_key: string | null; jurisdiction_iso: string | null; source_id: string | null; provenance_status: string | null }
const COLUMNS = "id, legacy_id, title, item_type, instrument_type, instrument_identifier, canonical_instrument_key, jurisdiction_iso, source_id, provenance_status";

/** ONE keyed lookup: a full id, an exact legacy_id, or a legacy_id prefix that names exactly one item. */
export async function resolveItemKey(sb: Db, key: string): Promise<{ item: KeyedItem | null; error: string | null }> {
  const read = (q: (n: number) => PromiseLike<{ data: KeyedItem[] | null; error: { message: string } | null }>) => boundedRead<KeyedItem>(q as never, { limit: 3 });
  if (isUuid(key as unknown)) {
    const r = await read((n) => sb.from("intelligence_items").select(COLUMNS).eq("id", key).limit(n));
    return r.error ? { item: null, error: `item lookup failed: ${r.error.message}` } : { item: r.data[0] ?? null, error: r.data[0] ? null : `item not found: ${key}` };
  }
  const exact = await read((n) => sb.from("intelligence_items").select(COLUMNS).eq("legacy_id", key).limit(n));
  if (exact.error) return { item: null, error: `item lookup failed: ${exact.error.message}` };
  if (exact.data[0]) return { item: exact.data[0], error: null };
  const prefix = await read((n) => sb.from("intelligence_items").select(COLUMNS).like("legacy_id", `${key.replace(/[%_]/g, "")}%`).limit(n));
  if (prefix.error) return { item: null, error: `item lookup failed: ${prefix.error.message}` };
  if (prefix.data.length > 1) return { item: null, error: `key '${key}' is ambiguous (${prefix.data.length}+ items)` };
  return { item: prefix.data[0] ?? null, error: prefix.data[0] ? null : `item not found: ${key}` };
}

export type IdStampStatus = "stamped" | "would_stamp" | "lease_not_held" | "no_capture" | "refused_not_id_confirmed" | "not_found" | "failed";
export type IdStampResult = RunResult & { status: IdStampStatus; itemId: string | null; before?: TargetMatch; proposed?: TargetMatch };

export async function idStamp(deps: { sb: Db; sources: Pick<SourcesDeps, "matchTarget"> }, input: { itemKey: string; proposedId: string; holder: string; apply?: boolean }): Promise<IdStampResult> {
  const { sb } = deps;
  const out = (status: IdStampStatus, itemId: string | null, notes: string[], extra: Partial<IdStampResult> = {}): IdStampResult => ({ ...runResult(status === "stamped" || status === "would_stamp" ? "ok" : "failed", { stamped: status === "stamped" ? 1 : 0 }, notes), status, itemId, ...extra });
  const found = await resolveItemKey(sb, input.itemKey);
  if (!found.item) return out("not_found", null, [found.error ?? "item not found"]);
  const it = found.item;
  // No lease, no touch: the holder must already own it (a lookup that errors is "not held", never "held").
  let held = false;
  try {
    held = await heartbeatLease(sb, it.id, input.holder);
  } catch (e) {
    return out("lease_not_held", it.id, [e instanceof Error ? e.message : String(e)]);
  }
  if (!held) return out("lease_not_held", it.id, [`LEASE NOT HELD by "${input.holder}" for ${it.id}: refusing to touch`]);
  let pool;
  try {
    pool = await readPool(sb, it.id);
  } catch (e) {
    return out("failed", it.id, [`pool read failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
  if (!pool.length) return out("no_capture", it.id, [`no staged capture for ${it.legacy_id ?? it.id}: cannot verify`]);
  const capture = pool.map((p) => p.text).join("\n\n");
  const identity = { title: it.title, item_type: it.item_type, instrument_type: it.instrument_type, canonical_instrument_key: it.canonical_instrument_key, jurisdiction: it.jurisdiction_iso };
  const flat = pool.map((p) => ({ url: p.url, text: p.text }));
  const before = deps.sources.matchTarget(flat, { ...identity, identifier: it.instrument_identifier });
  const proposed = deps.sources.matchTarget(flat, { ...identity, identifier: input.proposedId });
  const confirmed = proposed.verdict === "match" && isVerbatim(capture, input.proposedId);
  if (!confirmed) return out("refused_not_id_confirmed", it.id, [`proposed id does not id-confirm the staged capture (verdict ${proposed.verdict}; verbatim ${isVerbatim(capture, input.proposedId)})`], { before, proposed });
  if (!input.apply) return out("would_stamp", it.id, ["dry: would stamp instrument_identifier"], { before, proposed });
  const upd = await sb.from("intelligence_items").update({ instrument_identifier: input.proposedId }).eq("id", it.id);
  if (upd.error) return out("failed", it.id, [`stamp write failed: ${upd.error.message}`], { before, proposed });
  const back = await sb.from("intelligence_items").select("instrument_identifier").eq("id", it.id).maybeSingle();
  const live = (back.data as { instrument_identifier?: string | null } | null)?.instrument_identifier;
  if (back.error || live !== input.proposedId) return out("failed", it.id, [back.error ? `read-back failed: ${back.error.message}` : `read-back mismatch: live '${live ?? "null"}'`], { before, proposed });
  return out("stamped", it.id, [`stamped instrument_identifier=${input.proposedId} (read back)`], { before, proposed });
}
