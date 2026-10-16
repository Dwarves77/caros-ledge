// Ported from old_repo/scripts/regen-quarantined.mjs (lines 13-62)
// The $0 re-verify of quarantined items. A cheap re-verify asks one question of data already held: is every FACT span of the item still
// verbatim in the stored capture it is attributed to? Yes, and at least one FACT exists, is `verified_cheap`: the validation RPC is then
// re-run so the set_provenance_status trigger can flip the item if it passes the full gate. Anything else is `needs_acquire` (a held
// state, resolved by a session-authored ledger). No fetch, no model. The re-validate RPC and the read-back are CHECKED (the rpc result
// was once ignored). A source that changed since capture needs a network probe: none runs in build mode (scrape cadence is held off).
import { isVerbatim } from "@/core/contracts/verbatim";
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";
import { runResult, type RunResult } from "@/core/intake/result";

/** item_types excluded from automated re-verify pending the Q2 calibration spec. */
export const HOLD_TYPES: ReadonlySet<string> = new Set(["research_finding", "technology", "tool", "innovation"]);

export type CheapOutcome = "verified_cheap" | "needs_acquire";
export interface CheapDecision { outcome: CheapOutcome; reason: string }

/** Are all of the item's FACT spans still verbatim in their own captures? Reads fail loud (never "nothing to verify"). */
export async function cheapReverify(sb: Db, itemId: string): Promise<CheapDecision> {
  const facts = await fetchAllRows<{ id: string; source_span: string | null; search_result_id: string | null }>((from, to) => sb.from("section_claim_provenance").select("id, source_span, search_result_id").eq("intelligence_item_id", itemId).eq("claim_kind", "FACT").order("id", { ascending: true }).range(from, to), { cap: 20_000 });
  if (!facts.length) return { outcome: "needs_acquire", reason: "no FACT claims to verify" };
  const ids = [...new Set(facts.map((f) => f.search_result_id).filter((x): x is string => !!x))];
  const caps = await fetchAllByIdChunks(ids, async (slice) => {
    const r = await sb.from("agent_run_searches").select("id, result_content").in("id", slice);
    if (r.error) throw new LookupError("agent_run_searches", r.error);
    return (r.data ?? []) as { id: string; result_content: string | null }[];
  });
  const text = new Map(caps.map((c) => [c.id, c.result_content ?? ""]));
  const bad = facts.filter((f) => !f.search_result_id || !isVerbatim(text.get(f.search_result_id), f.source_span));
  return bad.length ? { outcome: "needs_acquire", reason: `${bad.length} of ${facts.length} FACT span(s) are not verbatim in their stored capture` } : { outcome: "verified_cheap", reason: `all ${facts.length} FACT span(s) verbatim in their stored captures` };
}

export interface ResolverInput { apply?: boolean; limit?: number; only?: string[] | null }
export type ResolverResult = RunResult & { decisions: { key: string; itemId: string; outcome: string; reason: string }[] };

/** Drive the quarantined to verified_cheap resolution loop over the non-held item types. Dry by default: decisions only, no RPC. */
export async function resolveQuarantined(sb: Db, input: ResolverInput = {}): Promise<ResolverResult> {
  const notes: string[] = [];
  const counts: Record<string, number> = { quarantined: 0, held_types: 0, eligible: 0, flipped: 0, cheap_still_quarantined: 0, needs_acquire: 0, errors: 0 };
  const decisions: ResolverResult["decisions"] = [];
  let all: { id: string; legacy_id: string | null; title: string | null; item_type: string }[];
  try {
    all = await fetchAllRows((from, to) => sb.from("intelligence_items").select("id, legacy_id, title, item_type").eq("is_archived", false).eq("provenance_status", "quarantined").order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  } catch (e) {
    return { ...runResult("failed", counts, [`quarantine read failed: ${e instanceof Error ? e.message : String(e)}`]), decisions };
  }
  counts.quarantined = all.length;
  const held = all.filter((i) => HOLD_TYPES.has(i.item_type));
  counts.held_types = held.length;
  let targets = all.filter((i) => !HOLD_TYPES.has(i.item_type));
  if (input.only?.length) targets = targets.filter((i) => input.only?.some((w) => i.legacy_id === w || i.id.startsWith(w)));
  counts.eligible = targets.length;
  for (const it of targets.slice(0, input.limit ?? targets.length)) {
    const key = it.legacy_id || it.id.slice(0, 8);
    try {
      const d = await cheapReverify(sb, it.id);
      if (d.outcome !== "verified_cheap") {
        counts.needs_acquire = (counts.needs_acquire ?? 0) + 1;
        decisions.push({ key, itemId: it.id, outcome: "needs-acquire", reason: d.reason });
        continue;
      }
      if (!input.apply) {
        decisions.push({ key, itemId: it.id, outcome: "cheap-ok", reason: d.reason });
        continue;
      }
      const rpc = await sb.rpc("validate_item_provenance", { p_item_id: it.id });
      if (rpc.error) throw new Error(`validate_item_provenance failed: ${rpc.error.message}`);
      const fin = await sb.from("intelligence_items").select("provenance_status").eq("id", it.id).maybeSingle();
      if (fin.error) throw new Error(`provenance read-back failed: ${fin.error.message}`);
      const verified = (fin.data as { provenance_status?: string } | null)?.provenance_status === "verified";
      counts[verified ? "flipped" : "cheap_still_quarantined"] = (counts[verified ? "flipped" : "cheap_still_quarantined"] ?? 0) + 1;
      decisions.push({ key, itemId: it.id, outcome: verified ? "verified" : "cheap-ok-still-quarantined", reason: d.reason });
    } catch (e) {
      counts.errors = (counts.errors ?? 0) + 1;
      decisions.push({ key, itemId: it.id, outcome: "error", reason: e instanceof Error ? e.message : String(e) });
      notes.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...runResult((counts.errors ?? 0) > 0 ? "partial" : "ok", counts, notes), decisions };
}
