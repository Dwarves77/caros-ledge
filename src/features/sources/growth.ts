// Ported from old_repo/src/lib/sources/source-growth.ts (lines 1-584)
// Ported from old_repo/src/lib/sources/tier-opinion-writer.ts (lines 1-92)
// Ported from old_repo/src/lib/sources/cited-host-gate.mjs (lines 1-19)
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { hostOf } from "@/core/shared";
import { classifySourceRole } from "@/core/sources/classify";
import { classTierForHost, decidePoolHostRegistration } from "@/core/sources/host-class";
import { buildResolver, hostInstitution, type SourceRow } from "@/core/sources/institution";
import { exactHostUrlFilter, lookupExactHost } from "@/core/sources/register";
import { outcomeOf, type RunDeps, type RunResult } from "@/core/sources/run-result";
import { recomputeEffectiveTier } from "@/core/sources/tier-movement";
import { writeEffectiveTierUnlessOverridden } from "@/core/sources/tier-writers";
import { computeCitationComponent } from "@/core/sources/trust-score";
import type { SourceTier, TrustMetrics } from "@/core/sources/types";

export { exactHostUrlFilter };

export interface CitationEdge {
  citer_source_id: string;
  citer_tier: number;
  /** Citers republishing the SAME announcement share a group key. A group collapses to ONE corroboration. */
  syndication_group?: string | null;
}
export interface ConvergenceMetrics {
  independent_citers: number;
  highest_citing_tier: number | null;
  confirmation_count: number;
  total_citations: number;
}
/** Collapse syndication, then count distinct independent corroborators and the best citing tier. A syndication group counts ONCE at its best tier (INV-179). */
export function aggregateConvergence(edges: CitationEdge[]): ConvergenceMetrics {
  const unit = new Map<string, number>();
  for (const e of edges) {
    const key = e.syndication_group ? `g:${e.syndication_group}` : `s:${e.citer_source_id}`;
    const prev = unit.get(key);
    unit.set(key, prev == null ? e.citer_tier : Math.min(prev, e.citer_tier));
  }
  const tiers = [...unit.values()];
  return { independent_citers: unit.size, highest_citing_tier: tiers.length ? Math.min(...tiers) : null, confirmation_count: unit.size, total_citations: edges.length };
}
export const citationScore = (m: ConvergenceMetrics): number =>
  computeCitationComponent({ independent_citers: m.independent_citers, highest_citing_tier: m.highest_citing_tier as SourceTier | null, confirmation_count: m.confirmation_count, conflict_count: 0, total_checks: 0, self_citation_count: 0 } as unknown as TrustMetrics);

export interface CitedSourceInput {
  name: string;
  url: string;
  /** An EXPLICIT tier estimate only. A missing estimate stays undefined and is never recorded as an opinion (INV-179). */
  tier_estimate?: number | null;
  rejection_reason?: string | null;
  syndication_group?: string | null;
}
export interface RegisteredCitation {
  url: string;
  source_id: string | null;
  registered: "existing" | "new_source" | "candidate" | "lookup_failed";
  class_tier?: number | null;
  opinion_tier?: number | null;
  error?: string;
}

/** Cited-host gate: a cited URL whose host or institution the system does not already know is novel (cross-run self-licensing stays closed). */
export function partitionCitedByHost<T extends { host: string; institution: string }>(cited: readonly T[], knownHosts: ReadonlySet<string>, knownInstitutions: ReadonlySet<string>) {
  const allowed: T[] = [];
  const novel: T[] = [];
  for (const c of cited) ((!!c.host && knownHosts.has(c.host)) || (!!c.institution && knownInstitutions.has(c.institution)) ? allowed : novel).push(c);
  return { allowed, novel };
}

export type OpinionSource = "haiku_brief_classifier" | "haiku_verification" | "operator_review" | "host_class_table";
/** Record a tier opinion (evidence only, never a tier). The result is read: a failed insert is returned with its full diagnostic, never swallowed. */
export async function recordTierOpinion(db: Db, i: { targetSourceId: string; opinedTier: number; opiningSourceId?: string | null; intelligenceItemId?: string | null; opinionSource?: OpinionSource }): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db.from("source_tier_opinions").insert({ target_source_id: i.targetSourceId, opined_tier: i.opinedTier, opinion_source: i.opinionSource ?? "haiku_brief_classifier", opining_source_id: i.opiningSourceId ?? null, intelligence_item_id: i.intelligenceItemId ?? null });
  return error ? { ok: false, error: `message=${error.message} | code=${(error as { code?: string }).code ?? "none"}` } : { ok: true };
}

export interface RegisterOpts {
  /** The pre-grounding register step already recorded the opinions for this list; the later grow step only needs the resolved ids. */
  skipTierOpinions?: boolean;
  /** For an existing source whose citation carries no estimate, record the class-table tier as a host_class_table opinion when it disagrees with base_tier. */
  classTableOpinions?: boolean;
  opiningSourceId?: string | null;
  intelligenceItemId?: string | null;
  /** Resolve every decision with read-only lookups and write nothing. */
  dry?: boolean;
}
async function worklist(db: Db, cs: CitedSourceInput, note: string, dry?: boolean): Promise<string | null> {
  if (dry) return null;
  const { error } = await db.from("provisional_sources").upsert({ name: cs.name, url: cs.url, status: "pending_review", reviewer_notes: note }, { onConflict: "url" });
  return error ? error.message : null;
}

/**
 * Register cited sources: an existing exact-host source resolves to its id (and may take an opinion); a classifiable new host becomes a sources row at its class tier; a blocked or
 * unclassifiable one becomes a provisional_sources candidate. Every read and write is checked: a failed duplicate lookup is `lookup_failed` and registers nothing (no duplicate row).
 */
export async function registerCitedSources(db: Db, cited: CitedSourceInput[], opts: RegisterOpts = {}): Promise<RegisteredCitation[]> {
  const out: RegisteredCitation[] = [];
  for (const cs of cited) {
    const host = hostOf(cs.url);
    const found = host ? await lookupExactHost(db, cs.url) : ({ ok: true, rows: [] } as const);
    if (!found.ok) {
      out.push({ url: cs.url, source_id: null, registered: "lookup_failed", error: found.error });
      continue;
    }
    const row = found.rows[0];
    if (row) {
      if (cs.tier_estimate != null && !opts.skipTierOpinions) {
        if (!opts.dry) await recordTierOpinion(db, { targetSourceId: row.id, opinedTier: cs.tier_estimate });
        out.push({ url: cs.url, source_id: row.id, registered: "existing" });
      } else if (opts.classTableOpinions && cs.tier_estimate == null) {
        const classTier = classTierForHost(host, cs.name);
        let opinion: number | null = null;
        if (classTier != null && row.base_tier != null && classTier !== row.base_tier && row.tier_override == null) {
          opinion = classTier;
          if (!opts.dry) await recordTierOpinion(db, { targetSourceId: row.id, opinedTier: classTier, opinionSource: "host_class_table", opiningSourceId: opts.opiningSourceId ?? null, intelligenceItemId: opts.intelligenceItemId ?? null });
        }
        out.push({ url: cs.url, source_id: row.id, registered: "existing", class_tier: classTier, opinion_tier: opinion });
      } else out.push({ url: cs.url, source_id: row.id, registered: "existing" });
      continue;
    }
    if (cs.rejection_reason) {
      const err = await worklist(db, cs, `auto-surfaced citation; blocked: ${cs.rejection_reason}`, opts.dry);
      out.push({ url: cs.url, source_id: null, registered: "candidate", ...(err ? { error: err } : {}) });
      continue;
    }
    // The tier is the class table's or nothing: a missing class tier is worklisted, never defaulted (INV-176).
    const classTier = classTierForHost(host, cs.name);
    if (classTier == null) {
      const err = await worklist(db, cs, `auto-surfaced citation; host did not classify to a ruled class-table tier (host=${host}): worklist for tier classification`, opts.dry);
      out.push({ url: cs.url, source_id: null, registered: "candidate", class_tier: null, opinion_tier: null, ...(err ? { error: err } : {}) });
      continue;
    }
    if (opts.dry) {
      out.push({ url: cs.url, source_id: null, registered: "new_source", class_tier: classTier, opinion_tier: null });
      continue;
    }
    const ins = await db.from("sources").insert({ name: cs.name, url: cs.url, base_tier: classTier, tier_at_creation: classTier, status: "provisional", auto_run_enabled: false, source_role: classifySourceRole(cs.name, cs.url) }).select("id").single();
    out.push(ins.error || !ins.data ? { url: cs.url, source_id: null, registered: "candidate", error: ins.error?.message ?? "no row returned" } : { url: cs.url, source_id: (ins.data as { id: string }).id, registered: "new_source" });
  }
  return out;
}

/** Record citation edges item-source to cited source. One insert per edge: the (citing, cited) pair is UNIQUE, so 23505 means already recorded; a self-citation is skipped (INV-179). */
export async function recordCitations(db: Db, edges: Array<{ citing_source_id: string; cited_source_id: string; syndication_group?: string | null }>): Promise<{ recorded: number; errors: string[] }> {
  let recorded = 0;
  const errors: string[] = [];
  for (const e of edges) {
    if (e.citing_source_id === e.cited_source_id) continue;
    const context = e.syndication_group ? `syndication:${e.syndication_group}` : "brief-citation";
    const { error } = await db.from("source_citations").insert({ citing_source_id: e.citing_source_id, cited_source_id: e.cited_source_id, context });
    if (!error) recorded++;
    else if ((error as { code?: string }).code !== "23505") errors.push(`${e.citing_source_id}->${e.cited_source_id}: ${error.message}`);
  }
  return { recorded, errors };
}

/** Parse the brief's "New Sources Identified" table. A row's tier is its EXPLICIT tier cell or absent; a blocked row becomes a candidate with a reason. */
export function parseNewSourcesFromBrief(brief: string): CitedSourceInput[] {
  const m = (brief || "").match(/#+\s*New Sources Identified[\s\S]*?(?=\n#+\s|\s*$)/i);
  if (!m) return [];
  const out: CitedSourceInput[] = [];
  for (const line of m[0].split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((s) => s.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const urlCell = cells.find((c) => /https?:\/\//.test(c));
    const url = urlCell ? (urlCell.match(/https?:\/\/[^\s)|]+/) || [])[0] : undefined;
    if (!url) continue;
    const name = (cells[0] ?? "").replace(/\*+/g, "");
    if (/^source name$/i.test(name)) continue;
    const tierCell = cells.find((c) => /^\(?[1-7]\)?$/.test(c));
    out.push({ name, url, ...(tierCell ? { tier_estimate: parseInt(tierCell.replace(/\D/g, ""), 10) } : {}), rejection_reason: /cloudflare|blocked|\b403\b|captcha|access denied/i.test(line) ? "cloudflare_block" : null });
  }
  return out;
}

/** Recompute convergence for a CITED source from its edges (syndication collapsed) and write the compounded credibility columns. Every read and the write throw on error. */
export async function compoundSourceCredibility(db: Db, citedSourceId: string) {
  const pre = await db.from("sources").select("independent_citers, trust_score_citation").eq("id", citedSourceId).maybeSingle();
  if (pre.error) throw new Error(`convergence pre-read failed for ${citedSourceId}: ${pre.error.message}`);
  const cits = await db.from("source_citations").select("citing_source_id, context").eq("cited_source_id", citedSourceId);
  if (cits.error) throw new Error(`citation-edge read failed for ${citedSourceId}: ${cits.error.message}`);
  const rows = (cits.data ?? []) as Array<{ citing_source_id: string; context: string }>;
  const citerIds = [...new Set(rows.map((r) => r.citing_source_id))];
  const tierById = new Map<string, number>();
  if (citerIds.length) {
    const citers = await db.from("sources").select("id, base_tier, effective_tier").in("id", citerIds);
    if (citers.error) throw new Error(`citer-tier read failed for ${citedSourceId}: ${citers.error.message}`);
    for (const s of (citers.data ?? []) as Array<{ id: string; base_tier: number; effective_tier: number | null }>) tierById.set(s.id, s.effective_tier ?? s.base_tier);
  }
  const conv = aggregateConvergence(rows.map((r) => ({ citer_source_id: r.citing_source_id, citer_tier: tierById.get(r.citing_source_id) ?? 7, syndication_group: typeof r.context === "string" && r.context.startsWith("syndication:") ? r.context.slice("syndication:".length) : null })));
  const score = citationScore(conv);
  const upd = await db.from("sources").update({ independent_citers: conv.independent_citers, highest_citing_tier: conv.highest_citing_tier, confirmation_count: conv.confirmation_count, total_citations: conv.total_citations, trust_score_citation: score }).eq("id", citedSourceId);
  if (upd.error) throw new Error(`credibility update failed for ${citedSourceId}: ${upd.error.message}`);
  const prev = pre.data as { independent_citers?: number; trust_score_citation?: number } | null;
  return { before: { independent_citers: prev?.independent_citers ?? 0, trust_score_citation: Number(prev?.trust_score_citation ?? 0) }, after: { ...conv, trust_score_citation: score } };
}

/** Register the item's pool-corroborator hosts before grounding, deterministically only: an institution that already resolves is inherited, a class-table host is registered, an ambiguous host is left unregistered (never a guessed tier). */
export async function registerPoolHostsForGrounding(db: Db, itemId: string): Promise<{ registered: number; institutions: number; failed: number }> {
  const pool = await db.from("agent_run_searches").select("result_url, search_query").eq("intelligence_item_id", itemId);
  if (pool.error) throw new Error(`pool read failed for ${itemId}: ${pool.error.message}`);
  if (!pool.data?.length) return { registered: 0, institutions: 0, failed: 0 };
  const sources = await fetchAllRows<SourceRow>((from, to) => db.from("sources").select("id, url, base_tier, effective_tier, tier_override, status").order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 });
  const resolver = buildResolver(sources);
  const seen = new Set<string>();
  const toRegister: CitedSourceInput[] = [];
  for (const r of pool.data as Array<{ result_url: string | null; search_query: string | null }>) {
    if (!r.result_url || r.search_query?.startsWith("canonical:cited")) continue; // citation stubs are not fetched pool content
    const inst = hostInstitution(hostOf(r.result_url));
    if (!inst || seen.has(inst)) continue;
    const decision = decidePoolHostRegistration(hostOf(r.result_url), resolver.resolveSpan(r.result_url).tier);
    if (decision.action === "inherit") continue;
    seen.add(inst);
    if (decision.action === "register") toRegister.push({ name: inst, url: r.result_url });
  }
  if (!toRegister.length) return { registered: 0, institutions: 0, failed: 0 };
  const out = await registerCitedSources(db, toRegister);
  return { registered: out.filter((o) => o.registered === "new_source").length, institutions: toRegister.length, failed: out.filter((o) => o.registered === "lookup_failed" || o.error).length };
}

/** The audit row for a reputation-cycle tier change; created_by satisfies the column CHECK, the actor rides in details. */
export function buildReputationEventRow(sourceId: string, r: { before_tier: number; after_tier: number; weighted_sum: number; citation_count: number; reasoning: string }) {
  return { source_id: sourceId, event_type: r.after_tier < r.before_tier ? "tier_promotion" : "tier_demotion", details: { actor: "reputation-cycle", reputation_cycle: true, ...r }, created_by: "worker" };
}
/** End-of-cycle reputation recompute for ONE source: effective_tier only, through the override-guarded write; an admin override is left entirely alone. Errors are returned, not logged away. */
export async function applyReputationRecompute(db: Db, sourceId: string, now: Date): Promise<{ before: number; after: number; changed: boolean; override_skipped: boolean; error: string | null }> {
  try {
    const r = await recomputeEffectiveTier(db, sourceId, { now });
    const d = r.decision;
    const res = { before: d.before_tier, after: d.after_tier, changed: d.changed, override_skipped: false, error: null as string | null };
    if (!d.changed || d.tier_override != null) return res;
    const w = await writeEffectiveTierUnlessOverridden(db, sourceId, d.after_tier);
    if (w.error) return { ...res, changed: false, error: `effective_tier write failed: ${w.error.message}` };
    if (!w.written) return { ...res, changed: false, override_skipped: true };
    const ev = await db.from("source_trust_events").insert(buildReputationEventRow(sourceId, { before_tier: d.before_tier, after_tier: d.after_tier, weighted_sum: r.weighted_sum, citation_count: r.citation_count, reasoning: d.reasoning }));
    return ev.error ? { ...res, error: `source_trust_events insert failed: ${ev.error.message}` } : res;
  } catch (e) {
    return { before: 0, after: 0, changed: false, override_skipped: false, error: (e as Error).message };
  }
}

/** Distinct-by-host cited sources from a url list, dropping unparseable urls and excluded hosts. */
export function collectCitedSources(urls: Array<string | { url: string; name?: string | null }>, excludeHosts: ReadonlySet<string> = new Set()): CitedSourceInput[] {
  const seen = new Set<string>();
  const out: CitedSourceInput[] = [];
  for (const u of urls) {
    const url = typeof u === "string" ? u : u?.url;
    const host = typeof url === "string" ? hostOf(url) : "";
    if (!host || excludeHosts.has(host) || seen.has(host)) continue;
    seen.add(host);
    out.push({ name: typeof u === "string" || !u.name ? host : u.name, url: url as string });
  }
  return out;
}

export interface GrowInput {
  /** The brief item's own source. */
  citedSourceId: string;
  brief: string;
  /** The free brief path carries no table: its cited sources arrive as a list. */
  extra?: { cited?: CitedSourceInput[]; citedSourceIds?: string[]; intelligenceItemId?: string | null };
  dry?: boolean;
}
/**
 * THE source-growth step end to end (rule 17: connection, credibility and reputation in one call): parse the surfaced sources, register each, record the edges to the subject,
 * compound the subject's credibility, recompute its reputation, and register the free path's cited sources the same way.
 */
export async function growSources(deps: RunDeps, input: GrowInput): Promise<RunResult> {
  const { db, now } = deps;
  const notes: string[] = [];
  const cited = parseNewSourcesFromBrief(input.brief);
  const registered = await registerCitedSources(db, cited, { skipTierOpinions: true, ...(input.dry ? { dry: true } : {}) });
  const failed = registered.filter((r) => r.registered === "lookup_failed" || r.error);
  for (const f of failed) notes.push(`${f.url}: ${f.error}`);
  let recorded = 0;
  let reputationChanged = 0;
  if (!input.dry) {
    const rec = await recordCitations(db, registered.filter((r) => r.source_id).map((r) => ({ citing_source_id: r.source_id as string, cited_source_id: input.citedSourceId })));
    recorded = rec.recorded;
    notes.push(...rec.errors);
    await compoundSourceCredibility(db, input.citedSourceId);
    const rep = await applyReputationRecompute(db, input.citedSourceId, now());
    if (rep.error) notes.push(`reputation: ${rep.error}`);
    reputationChanged = rep.changed ? 1 : 0;
  }
  let entryEdges = 0;
  if (input.extra) {
    const extra = await registerEntryCitations(deps, input.citedSourceId, input.extra.cited ?? [], { citedSourceIds: input.extra.citedSourceIds ?? [], intelligenceItemId: input.extra.intelligenceItemId ?? null, excludeHosts: new Set(cited.map((c) => hostOf(c.url))), dry: !!input.dry });
    entryEdges = extra.edges;
    notes.push(...extra.notes);
  }
  const bad = failed.length + notes.filter((n) => n.startsWith("reputation:")).length;
  return { counts: { cited: cited.length, registered: registered.filter((r) => r.registered === "new_source").length, failed: failed.length, citations_recorded: recorded, entry_edges: entryEdges, reputation_changed: reputationChanged }, outcome: outcomeOf(cited.length + entryEdges, bad), notes, data: { registered } };
}

/** The free-brief-path registration: every distinct external host an item cites, plus every cited source id, registered the same way as the table path, edges written and credibility compounded in the same call. */
export async function registerEntryCitations(deps: RunDeps, itemSourceId: string, cited: Array<string | CitedSourceInput>, opts: { dry?: boolean; citedSourceIds?: string[]; intelligenceItemId?: string | null; excludeHosts?: ReadonlySet<string> } = {}) {
  const { db, now } = deps;
  const own = await db.from("sources").select("url").eq("id", itemSourceId).maybeSingle();
  if (own.error) throw new Error(`own-source read failed for ${itemSourceId}: ${own.error.message}`);
  const exclude = new Set<string>(opts.excludeHosts ?? []);
  const ownHost = hostOf((own.data as { url?: string } | null)?.url);
  if (ownHost) exclude.add(ownHost);
  const list = collectCitedSources(cited, exclude);
  const notes: string[] = [];
  const targets: string[] = [];
  const regs = list.length ? await registerCitedSources(db, list, { classTableOpinions: true, opiningSourceId: itemSourceId, intelligenceItemId: opts.intelligenceItemId ?? null, ...(opts.dry ? { dry: true } : {}) }) : [];
  for (const r of regs) {
    if (r.source_id) targets.push(r.source_id);
    else if (r.registered === "lookup_failed" || r.error) notes.push(`${r.url}: ${r.error}`);
  }
  const ids = [...new Set((opts.citedSourceIds ?? []).filter((x) => x && x !== itemSourceId))];
  if (ids.length) {
    const found = await db.from("sources").select("id").in("id", ids);
    if (found.error) throw new Error(`cited-source-id read failed: ${found.error.message}`);
    targets.push(...((found.data ?? []) as Array<{ id: string }>).map((f) => f.id));
  }
  const unique = [...new Set(targets)];
  if (opts.dry) return { decisions: regs, edges: unique.length, notes };
  const rec = await recordCitations(db, unique.map((t) => ({ citing_source_id: itemSourceId, cited_source_id: t })));
  notes.push(...rec.errors);
  for (const t of unique) {
    try {
      await compoundSourceCredibility(db, t);
    } catch (e) {
      notes.push(`compound ${t}: ${(e as Error).message}`);
    }
    const rep = await applyReputationRecompute(db, t, now());
    if (rep.error) notes.push(`reputation ${t}: ${rep.error}`);
  }
  return { decisions: regs, edges: rec.recorded, notes };
}
