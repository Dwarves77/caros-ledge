// Ported from old_repo/scripts/_reground/free-pass-run.mjs (lines 19-106)
// Ported from old_repo/scripts/lib/free-pass.mjs (lines 1-48)
// The $0 floor-first re-attribution of a non-verified item (INV-056). A FACT whose attributed source is below the item type's authority
// floor, or unresolved, is re-homed to a floor-qualifying source THE ITEM ALREADY HOLDS when the span is verbatim in that stored capture,
// the capture is not an error body, and the capture is a primary instrument (officialness path a). Nothing is fetched and nothing is
// authored; a codified host that is not yet registered is registered and rated first (SC-13 / rule 18) through the sources dependency.
// The re-home of an item is ONE ledger transaction (ledger_apply_ops): each failing FACT is stood on the floor capture that holds its span, with the source and tier of THAT capture's host and its capture id
// (the old writer set the floor source's tier and left the span on the below-floor capture), the prior state archived to claim_versions first; a refusal leaves the item as it was. Every write is checked, and
// the item is read back: a re-home that did not flip the item is reported as such, never as a success.
import { fetchAllRows, type Db } from "@/core/db";
import { applyLedgerOps, reattributeClaim, type LedgerOp } from "@/core/grounding/ledger";
import { authorityFloorFor, floorPool, readPool, reattributeToFloor } from "@/core/grounding/pool";
import { runResult, type RunResult } from "@/core/intake/result";
import { hostOf } from "@/core/shared/url";

import type { SourcesDeps } from "../deps";

export type RehomeOutcome = "WOULD-FLIP" | "VERIFIED-FREE" | "REHOMED-STILL-QUARANTINED" | "RESIDUAL-ACQUIRE" | "NO-FACTS" | "NON-TIER-FAILURE" | "EXEMPT" | "ERROR";
export interface RehomeDecision { key: string; itemId: string; outcome: RehomeOutcome; detail: string; rehomed?: number }
export type RehomeResult = RunResult & { decisions: RehomeDecision[] };
interface Capture { id: string; url: string; text: string; tier: number | null; sourceId: string | null; host: string; needsRegister: boolean }
interface FactRow { id: string; source_span: string | null; source_id: string | null; source_tier_at_grounding: number | null; claim_kind: string }
type Deps = { sb: Db; sources: Pick<SourcesDeps, "resolveSource" | "classTierForHost" | "registerAndRate" | "classifyBody" | "officialness">; now: () => Date };

export async function rehomeQuarantined(deps: Deps, input: { apply?: boolean; limit?: number; only?: string[] | null } = {}): Promise<RehomeResult> {
  const { sb, sources } = deps;
  const decisions: RehomeDecision[] = [];
  const counts: Record<string, number> = { items: 0, would_flip: 0, verified_free: 0, still_quarantined: 0, residual: 0, no_facts: 0, non_tier: 0, errors: 0 };
  const bump = (k: string) => void (counts[k] = (counts[k] ?? 0) + 1);
  const notes: string[] = [];
  let items: { id: string; legacy_id: string | null; item_type: string; source_id: string | null }[];
  try {
    items = await fetchAllRows((from, to) => sb.from("intelligence_items").select("id, legacy_id, item_type, source_id").eq("is_archived", false).neq("provenance_status", "verified").order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  } catch (e) {
    return { ...runResult("failed", counts, [`item read failed: ${e instanceof Error ? e.message : String(e)}`]), decisions };
  }
  if (input.only?.length) items = items.filter((it) => input.only?.some((k) => it.legacy_id === k || it.id.startsWith(k)));
  items = items.slice(0, input.limit ?? items.length);
  counts.items = items.length;

  for (const it of items) {
    const key = it.legacy_id ?? it.id.slice(0, 8);
    const done = (outcome: RehomeOutcome, detail: string, rehomed?: number) => decisions.push({ key, itemId: it.id, outcome, detail, ...(rehomed !== undefined ? { rehomed } : {}) });
    try {
      const floor = authorityFloorFor(it.item_type);
      if (floor == null) {
        done("EXEMPT", `item_type ${it.item_type} has no authority floor`);
        continue;
      }
      const facts = (await fetchAllRows<FactRow>((from, to) => sb.from("section_claim_provenance").select("id, source_span, source_id, source_tier_at_grounding, claim_kind").eq("intelligence_item_id", it.id).order("id", { ascending: true }).range(from, to), { cap: 20_000 })).filter((c) => String(c.claim_kind).toLowerCase() === "fact");
      if (!facts.length) {
        bump("no_facts");
        done("NO-FACTS", "no FACT claims: re-synthesise through the injected-brief seam");
        continue;
      }
      const failing = facts.filter((c) => c.source_tier_at_grounding == null || c.source_tier_at_grounding > floor);
      if (!failing.length) {
        bump("non_tier");
        done("NON-TIER-FAILURE", "floor is met; the quarantine is a label, slot or span-not-in-source failure");
        continue;
      }
      // The captures the item holds (its stored pool), each resolved to a tier; an unresolved host takes its codified class tier (SC-13).
      const pool = await readPool(sb, it.id);
      const captures: Capture[] = [];
      for (const p of pool) {
        const r = await sources.resolveSource(p.url);
        const host = hostOf(p.url);
        const codified = r?.tier == null ? sources.classTierForHost(host) : null;
        if (sources.classifyBody(p.text, p.url).errorBody) continue;
        captures.push({ id: p.id, url: p.url, text: p.text, tier: r?.tier ?? codified, sourceId: r?.sourceId ?? null, host, needsRegister: r?.tier == null && codified != null });
      }
      const ordered = floorPool(captures, floor).filter((c) => sources.officialness(c.url, c.text, { hostTier: c.tier, floorTier: floor }).path === "a");
      const homes: { claimId: string; target: Capture }[] = [];
      for (const c of failing) {
        const target = reattributeToFloor(c.source_span, c.source_tier_at_grounding, ordered, floor);
        if (target) homes.push({ claimId: c.id, target });
      }
      if (homes.length !== failing.length) {
        bump("residual");
        done("RESIDUAL-ACQUIRE", `${homes.length}/${failing.length} failing spans re-home to a held primary; the rest need a floor primary in the pool`, homes.length);
        continue;
      }
      if (!input.apply) {
        bump("would_flip");
        done("WOULD-FLIP", `${homes.length}/${failing.length} failing spans re-home to a held primary`, homes.length);
        continue;
      }
      const registered = new Map<string, string>();
      const ops: LedgerOp[] = [];
      for (const h of homes) {
        if (h.target.needsRegister) {
          const reg = await sources.registerAndRate(h.target.url);
          if (!reg.sourceId) throw new Error(`could not register ${h.target.host}${reg.refused ? ` (${reg.refused})` : ""}`);
          registered.set(h.target.url, reg.sourceId);
          h.target.needsRegister = false;
        }
        const claim = facts.find((f) => f.id === h.claimId) as FactRow;
        const resolve = async (url: string) => {
          const hit = registered.has(url) ? { sourceId: registered.get(url) as string } : await sources.resolveSource(url);
          return hit?.sourceId ? { sourceId: hit.sourceId } : null;
        };
        ops.push(await reattributeClaim({ id: h.claimId }, { id: h.target.id, url: h.target.url }, claim.source_span as string, { resolve }, "rehome:floor"));
      }
      await applyLedgerOps(sb, it.id, ops, deps.now().toISOString());
      const touch = await sb.from("intelligence_items").update({ updated_at: deps.now().toISOString() }).eq("id", it.id);
      if (touch.error) throw new Error(`item touch failed: ${touch.error.message}`);
      const fin = await sb.from("intelligence_items").select("provenance_status").eq("id", it.id).maybeSingle();
      if (fin.error) throw new Error(`provenance read-back failed: ${fin.error.message}`);
      const prov = (fin.data as { provenance_status?: string } | null)?.provenance_status;
      if (prov === "verified") {
        bump("verified_free");
        done("VERIFIED-FREE", "verified at $0 (read back)", homes.length);
      } else {
        bump("still_quarantined");
        done("REHOMED-STILL-QUARANTINED", `re-homed ${homes.length} but the item is still ${prov ?? "unknown"} (another criterion)`, homes.length);
      }
    } catch (e) {
      bump("errors");
      const m = e instanceof Error ? e.message : String(e);
      notes.push(`${key}: ${m}`);
      done("ERROR", m);
    }
  }
  return { ...runResult((counts.errors ?? 0) > 0 ? "partial" : "ok", counts, notes), decisions };
}
