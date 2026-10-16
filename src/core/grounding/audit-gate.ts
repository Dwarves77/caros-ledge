// Ported from old_repo/src/lib/agent/audit-gate.ts (lines 29-159)
// Ported from old_repo/src/lib/agent/audit-gate-core.mjs (lines 1-56)
// The cross-item audit gate in the write path (unregistered span host, claims-tier honesty, one tier per host) and the Layer C
// data-audit block row with its dated waiver. Pure checking here; the workflow owns the fail-closed action.
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";

export interface ResolvedSource { tier: number | null; institution: string | null; sourceId: string | null }
export type ResolveSource = (url: string) => ResolvedSource | null | Promise<ResolvedSource | null>;
export interface SourceRegRow { id: string; url: string; base_tier: number | null; tier_override: number | null }
export interface AuditClaim { id: string; claim_kind: string | null; search_result_id: string | null; source_tier_at_grounding: number | null }

/** Global one-tier-per-host violation count: an institution whose (non-overridden) sources carry more than one base tier. */
export async function hostTierViolationCount(sources: SourceRegRow[], resolve: ResolveSource): Promise<number> {
  const byInst = new Map<string, Set<number | null>>();
  for (const s of sources) {
    if (s.tier_override != null) continue;
    const inst = (await resolve(s.url))?.institution;
    if (inst) byInst.set(inst, (byInst.get(inst) ?? new Set()).add(s.base_tier ?? null));
  }
  return [...byInst.values()].filter((t) => t.size > 1).length;
}

/** Item-scoped unregistered-span and claims-tier scoring (the per-write mirror of the nightly corpus audits). */
export async function scoreItemClaims(claims: AuditClaim[], searchUrlById: Map<string, string | null>, resolve: ResolveSource, hostOf: (u: string) => string): Promise<{ unregisteredSpanFacts: number; claimsTierMismatches: number; sample: string[] }> {
  let unregisteredSpanFacts = 0;
  let claimsTierMismatches = 0;
  const sample: string[] = [];
  const note = (s: string) => void (sample.length < 8 && sample.push(s));
  for (const c of claims) {
    const stored = c.source_tier_at_grounding ?? null;
    if (c.claim_kind === "FACT") {
      const url = c.search_result_id ? (searchUrlById.get(c.search_result_id) ?? null) : null;
      const expected = url ? ((await resolve(url))?.tier ?? null) : null;
      if (c.search_result_id && expected == null) {
        unregisteredSpanFacts += 1;
        note(`unregistered-span FACT ${String(c.id).slice(0, 8)} host=${hostOf(url || "")}`);
      }
      if (stored !== expected) {
        claimsTierMismatches += 1;
        note(`claims-tier FACT ${String(c.id).slice(0, 8)} stored=${stored} expected=${expected ?? "NULL"}`);
      }
    } else if (stored !== null) {
      claimsTierMismatches += 1;
      note(`claims-tier ${c.claim_kind} ${String(c.id).slice(0, 8)} stored=${stored} expected=NULL`);
    }
  }
  return { unregisteredSpanFacts, claimsTierMismatches, sample };
}

/** The whole sources registry, paged under a total order (the registry exceeds the 1000-row response cap). */
export async function readAllSources(sb: Db): Promise<SourceRegRow[]> {
  return fetchAllRows<SourceRegRow>((from, to) => sb.from("sources").select("id, url, base_tier, tier_override").order("id", { ascending: true }).range(from, to), { cap: 200_000 });
}

export interface AuditResult { ok: boolean; detail: string; metrics: { unregisteredSpanFacts: number; claimsTierMismatches: number; hostTierViolations: number; baselineHostTierViolations: number } }
/**
 * THE GATE: an item's write is cross-item clean iff it grounded zero FACTs on unregistered hosts, has zero claims-tier mismatches and
 * introduced no new one-tier-per-host conflict versus the pre-write baseline. A read that fails throws (the caller fails closed).
 */
export async function crossItemAuditGate(sb: Db, itemId: string, baselineHostTierViolations: number, resolve: ResolveSource, hostOf: (u: string) => string): Promise<AuditResult> {
  const sources = await readAllSources(sb);
  const claims = await fetchAllRows<AuditClaim>((from, to) => sb.from("section_claim_provenance").select("id, claim_kind, search_result_id, source_tier_at_grounding").eq("intelligence_item_id", itemId).order("id", { ascending: true }).range(from, to), { cap: 20_000 });
  const ids = [...new Set(claims.map((c) => c.search_result_id).filter((x): x is string => !!x))];
  const rows = await fetchAllByIdChunks(ids, async (slice) => {
    const r = await sb.from("agent_run_searches").select("id, result_url").in("id", slice);
    if (r.error) throw new LookupError("agent_run_searches (audit)", r.error);
    return (r.data ?? []) as { id: string; result_url: string | null }[];
  });
  const item = await scoreItemClaims(claims, new Map(rows.map((r) => [r.id, r.result_url])), resolve, hostOf);
  const hostTierViolations = await hostTierViolationCount(sources, resolve);
  const reasons: string[] = [];
  if (item.unregisteredSpanFacts > 0) reasons.push(`unregistered_span_host(${item.unregisteredSpanFacts})`);
  if (item.claimsTierMismatches > 0) reasons.push(`claims_tier_mismatch(${item.claimsTierMismatches})`);
  if (hostTierViolations > baselineHostTierViolations) reasons.push(`one_tier_per_host_regression(${baselineHostTierViolations}->${hostTierViolations})`);
  const detail = reasons.length === 0 ? `cross-item audit clean (unregistered-span=0, claims-tier=0, host-tier ${hostTierViolations}<=${baselineHostTierViolations})` : `cross-item audit FAILED [${reasons.join(",")}]: ${item.sample.join(" | ")}`.slice(0, 240);
  return { ok: reasons.length === 0, detail, metrics: { unregisteredSpanFacts: item.unregisteredSpanFacts, claimsTierMismatches: item.claimsTierMismatches, hostTierViolations, baselineHostTierViolations } };
}

// ---- Layer C: the data-audit block ----------------------------------------------------------------------------
export interface BlockRow { id: string; description?: string | null; recommended_actions?: unknown }
/** A block is dispositioned only by an explicit, non-expired dated waiver. Time alone never clears it. */
export function hasValidWaiver(block: BlockRow | null | undefined, now: Date): boolean {
  const acts = block && Array.isArray(block.recommended_actions) ? (block.recommended_actions as { action?: string; until?: string }[]) : [];
  return acts.some((a) => a?.action === "waiver" && !!a.until && !Number.isNaN(new Date(a.until).getTime()) && new Date(a.until).getTime() >= now.getTime());
}
/** The single OPEN data-audit block row, if any; a read error throws (a gate that cannot verify state must not let generation proceed). */
export async function readOpenDataAuditBlock(sb: Db): Promise<BlockRow | null> {
  const { data, error } = await sb.from("integrity_flags").select("id, description, recommended_actions, status").eq("category", "data_integrity").eq("subject_ref", "data-audit-lane").eq("status", "open").limit(1).maybeSingle();
  if (error) throw new LookupError("integrity_flags (data-audit block)", error);
  return (data ?? null) as BlockRow | null;
}
