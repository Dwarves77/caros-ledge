// Ported from old_repo/src/lib/sources/verification.ts (lines 1-98)
// Ported from old_repo/src/lib/sources/verification.ts (lines 333-464)
// Ported from old_repo/src/lib/sources/verification.ts (lines 566-978)
import { fetchDirect, type FetchDeps } from "@/core/fetch/direct";
import { checkReachability, decideReachabilityAction, type Reachability } from "@/core/fetch/reachability";
import { hostOf } from "@/core/shared";
import { classifySourceRole } from "@/core/sources/classify";
import { placeHostWithVerdicts, type HostVerdictRef } from "@/core/sources/host-class";
import { lookupExactHost } from "@/core/sources/register";
import type { RunDeps, RunResult } from "@/core/sources/run-result";

import { checkVerticalFitGate } from "./vertical-fit-gate";

export type VerificationTier = "H" | "M" | "L";
export type VerificationAction = "auto-approved" | "queued-provisional" | "rejected";

/** A session-authored relevance verdict (the injected seam that replaces the model call): scores 0-100 and a rationale. */
export interface CandidateVerdict {
  relevance: number;
  freight: number;
  rationale: string;
}
export interface VerifyInput {
  url: string;
  name?: string;
  jurisdiction_iso?: string[];
  discoveredFor?: string;
  skipDuplicateCheck?: boolean;
  dry?: boolean;
  verdict?: CandidateVerdict | null;
  verdicts?: ReadonlyMap<string, HostVerdictRef> | null;
}
export interface VerificationResult {
  tier: VerificationTier;
  action: VerificationAction;
  relevance: number | null;
  freight: number | null;
  language: string | null;
  rejection_reason?: string;
  resulting_source_id?: string;
  resulting_provisional_id?: string;
  log: Record<string, unknown>;
}
export type VerifyDeps = RunDeps & FetchDeps;

const THRESHOLDS = { RELEVANCE_H: 75, RELEVANCE_M: 50, FREIGHT_H: 55, FREIGHT_M: 25 } as const;
const CONTENT_MAX_CHARS = 6_000;
const ENGLISH_STOPWORDS = new Set(["the", "and", "of", "to", "in", "is", "it", "for", "on", "with", "as", "by", "this", "that", "from", "or", "be", "are", "an", "at"]);

/** A binary English or not-English call: the ASCII letter ratio, then English stopword density. A false negative drops the row to M, the safe direction. */
export function detectLanguage(text: string): { language: string | null; method: "heuristic" | "fallback" } {
  if (!text || text.length < 100) return { language: null, method: "fallback" };
  const sample = text.slice(0, 4000);
  const nonSpace = (sample.match(/\S/g) ?? []).length;
  if (nonSpace === 0) return { language: null, method: "fallback" };
  if ((sample.match(/[a-zA-Z]/g) ?? []).length / nonSpace < 0.5) return { language: "non-english", method: "heuristic" };
  const hits = sample.toLowerCase().split(/\s+/).filter((w) => ENGLISH_STOPWORDS.has(w)).length;
  return { language: hits >= 8 ? "en" : "non-english", method: "heuristic" };
}

/** Domain confidence from the class table: a host-only class rule is high, a committed verdict or residue name rule is medium, no placement is low. */
function domainConfidence(via: "class" | "verdict" | "residue" | null): "high" | "medium" | "low" {
  return via === "class" ? "high" : via === "verdict" || via === "residue" ? "medium" : "low";
}

/** Conservative aggregation: any single L trigger forces L; a missing verdict or a non-English page is M; H needs both scores over the bar and a high-confidence class host. */
export function aggregateTier(i: { duplicate: boolean; duplicateLookupFailed: boolean; domain: "high" | "medium" | "low"; language: string | null; verdict: CandidateVerdict | null; offVertical: boolean }): { tier: VerificationTier; triggers: string[]; rejection_reason?: string } {
  if (i.duplicate) return { tier: "L", triggers: ["duplicate"], rejection_reason: "duplicate" };
  if (i.offVertical) return { tier: "L", triggers: ["off_vertical"], rejection_reason: "off_vertical" };
  if (i.duplicateLookupFailed) return { tier: "M", triggers: ["duplicate_lookup_failed"], rejection_reason: "duplicate_lookup_failed" };
  const v = i.verdict;
  if (v && v.relevance < THRESHOLDS.RELEVANCE_M) return { tier: "L", triggers: [`relevance_low(${v.relevance})`], rejection_reason: "relevance_low" };
  if (v && v.freight < THRESHOLDS.FREIGHT_M) return { tier: "L", triggers: [`freight_low(${v.freight})`], rejection_reason: "not_freight_relevant" };
  if (!v) return { tier: "M", triggers: ["verdict_missing"], rejection_reason: "verdict_missing" };
  if (i.language !== "en") return { tier: "M", triggers: [`language_${i.language ?? "unknown"}`], rejection_reason: "language_non_english" };
  if (i.domain === "low") return { tier: "M", triggers: ["domain_unknown"], rejection_reason: "domain_unknown" };
  if (v.relevance >= THRESHOLDS.RELEVANCE_H && v.freight >= THRESHOLDS.FREIGHT_H && i.domain === "high") return { tier: "H", triggers: [`H_clear(rel=${v.relevance},frt=${v.freight},dom=high)`] };
  return { tier: "M", triggers: [`M_default(rel=${v.relevance},frt=${v.freight},dom=${i.domain})`] };
}

/** Exact-host duplicate check: a registered row at the same canonical host whose path is this one or a parent of it. A read error is a failure, never "no duplicate" (B-0227). */
async function checkDuplicate(deps: VerifyDeps, url: string): Promise<{ matched: boolean; failed: boolean; matchedSourceId?: string; method?: "host" | "path" }> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return { matched: false, failed: false };
  }
  const found = await lookupExactHost(deps.db, url);
  if (!found.ok) return { matched: false, failed: true };
  for (const row of found.rows) {
    try {
      const existing = new URL(row.url ?? "").pathname.replace(/\/+$/, "") || "/";
      if (existing === pathname) return { matched: true, failed: false, matchedSourceId: row.id, method: "path" };
      if (pathname.startsWith(existing) || existing === "/") return { matched: true, failed: false, matchedSourceId: row.id, method: "host" };
    } catch {
      continue;
    }
  }
  return { matched: false, failed: false };
}

async function execute(deps: VerifyDeps, input: VerifyInput, tier: VerificationTier, language: string | null, reason: string | undefined, classTier: number | null) {
  if (tier === "L") return { action: "rejected" as VerificationAction };
  const name = input.name || input.url;
  const note = `${deps.now().toISOString().slice(0, 10)}`;
  if (tier === "H" && classTier != null) {
    // base_tier is the class table's tier, never a guess; an unplaced host falls through to the provisional queue.
    const { data, error } = await deps.db
      .from("sources")
      .insert({ name, url: input.url, description: input.verdict?.rationale ?? "", base_tier: classTier, tier_at_creation: classTier, domains: [1], jurisdictions: input.jurisdiction_iso ?? [], transport_modes: [], access_method: "scrape", status: "active", admin_only: false, source_role: classifySourceRole(name, input.url), update_frequency: "weekly", intelligence_types: [], vertical_tags: [], notes: `Auto-approved by candidate verification ${note}. base_tier=${classTier} (class table). Relevance advisory: rel=${input.verdict?.relevance ?? "?"}, frt=${input.verdict?.freight ?? "?"}.` })
      .select("id")
      .single();
    return error || !data ? { action: "rejected" as VerificationAction, error: `H insert failed: ${error?.message ?? "no row returned"}` } : { action: "auto-approved" as VerificationAction, resulting_source_id: (data as { id: string }).id };
  }
  const { data, error } = await deps.db
    .from("provisional_sources")
    .insert({ name, url: input.url, description: input.verdict?.rationale ?? `Queued by candidate verification. Reason: ${reason ?? "uncertain"}.`, discovered_via: "worker_search", status: "pending_review", provisional_tier: 7, recommended_tier: classTier, reviewer_notes: `Auto-queued ${note}: ${reason ?? "uncertain"}. lang=${language ?? "unknown"}. rel=${input.verdict?.relevance ?? "?"}, frt=${input.verdict?.freight ?? "?"}.` })
    .select("id")
    .single();
  if (error || !data) {
    // UNIQUE(url): a duplicate here is the idempotency net, not a failure.
    if ((error as { code?: string } | null)?.code === "23505") return { action: "queued-provisional" as VerificationAction };
    return { action: "rejected" as VerificationAction, error: `M insert failed: ${error?.message ?? "no row returned"}` };
  }
  return { action: "queued-provisional" as VerificationAction, resulting_provisional_id: (data as { id: string }).id };
}

/**
 * Candidate source verification (W2.F): reachability (a non-answer is M, only a 404 or 410 is L), exact-host duplicate check, class-table placement, English
 * heuristic, off-vertical gate, then the aggregated tier and the insert at the class tier or the provisional queue, with an audit row whose write is checked.
 * No model call: relevance and freight come from the optional session-authored `verdict`.
 */
export async function verifyCandidate(deps: VerifyDeps, input: VerifyInput): Promise<RunResult<VerificationResult>> {
  const started = deps.now().getTime();
  const host = hostOf(input.url);
  const notes: string[] = [];
  const log: Record<string, unknown> = { candidate_url: input.url, candidate_name: input.name, discoveredFor: input.discoveredFor };
  const finish = async (r: Omit<VerificationResult, "log">, errors: string[]): Promise<RunResult<VerificationResult>> => {
    const result: VerificationResult = { ...r, log: { ...log, timing: { totalMs: deps.now().getTime() - started } } };
    if (!input.dry) {
      const { error } = await deps.db.from("source_verifications").insert({ candidate_url: input.url, candidate_name: input.name ?? null, jurisdiction_iso: input.jurisdiction_iso ?? [], language: r.language, ai_relevance_score: r.relevance, ai_freight_score: r.freight, ai_trust_tier: null, verification_tier: r.tier, action_taken: r.action, rejection_reason: r.rejection_reason ?? null, verification_log: result.log, resulting_source_id: r.resulting_source_id ?? null, resulting_provisional_id: r.resulting_provisional_id ?? null });
      if (error) errors.push(`audit log write failed: ${error.message}`);
    }
    return { counts: { [r.action]: 1 }, outcome: errors.length ? "partial" : "ok", notes: [...notes, ...errors], data: result };
  };
  if (!host) return finish({ tier: "L", action: "rejected", relevance: null, freight: null, language: null, rejection_reason: "unparseable_url" }, []);

  const reach = await checkReachability(input.url, deps);
  log.reachability = { attempts: reach.attempts, finalStatus: reach.finalStatus, outcome: reach.outcome };
  const reachAction = decideReachabilityAction(reach.outcome as Reachability);
  const placement = placeHostWithVerdicts(host, [input.name], input.verdicts ?? null);
  if (reachAction.shortCircuit) {
    const exec = input.dry || reachAction.tier === "L" ? { action: reachAction.action as VerificationAction } : await execute(deps, input, "M", null, reachAction.rejection_reason, placement.tier);
    const errors = "error" in exec && exec.error ? [exec.error] : [];
    return finish({ tier: reachAction.tier, action: exec.action, relevance: null, freight: null, language: null, rejection_reason: reachAction.rejection_reason, ...("resulting_provisional_id" in exec && exec.resulting_provisional_id ? { resulting_provisional_id: exec.resulting_provisional_id } : {}) }, errors);
  }

  const dup = input.skipDuplicateCheck ? { matched: false, failed: false } : await checkDuplicate(deps, input.url);
  log.duplicate = dup;
  const gate = await checkVerticalFitGate(deps.db, { name: input.name, url: input.url, sourceRole: classifySourceRole(input.name ?? host, input.url) });
  log.verticalFit = { allow: gate.allow, reason: gate.reason };
  let language: string | null = null;
  if (!dup.matched) {
    try {
      const page = await fetchDirect(input.url, deps, { max: CONTENT_MAX_CHARS });
      language = detectLanguage(page.text).language;
      log.content = { status: page.status, textLength: page.text.length };
    } catch (e) {
      log.content = { error: (e as Error).message };
    }
  }
  const agg = aggregateTier({ duplicate: dup.matched, duplicateLookupFailed: dup.failed, domain: domainConfidence(placement.via), language, verdict: input.verdict ?? null, offVertical: !gate.allow });
  log.aggregation = { triggers: agg.triggers, decision: agg.tier };
  const exec = input.dry ? { action: (agg.tier === "H" ? "auto-approved" : agg.tier === "M" ? "queued-provisional" : "rejected") as VerificationAction } : await execute(deps, input, agg.tier, language, agg.rejection_reason, placement.tier);
  const errors = "error" in exec && exec.error ? [exec.error] : [];
  return finish({ tier: agg.tier, action: exec.action, relevance: input.verdict?.relevance ?? null, freight: input.verdict?.freight ?? null, language, ...(agg.rejection_reason ? { rejection_reason: agg.rejection_reason } : {}), ...("resulting_source_id" in exec && exec.resulting_source_id ? { resulting_source_id: exec.resulting_source_id } : {}), ...("resulting_provisional_id" in exec && exec.resulting_provisional_id ? { resulting_provisional_id: exec.resulting_provisional_id } : {}) }, errors);
}
