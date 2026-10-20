// Ported from old_repo/src/lib/agent/mint-gates.mjs (lines 1-34)
// Ported from old_repo/src/lib/agent/defect-signatures.mjs (lines 1-69)
// Ported from old_repo/src/lib/agent/gate-a-derived.mjs (lines 9-45)
// Ported from old_repo/src/lib/agent/null-tier-flag.mjs (lines 17-80)
// Ported from old_repo/src/lib/intake/write-item.ts (lines 3-50)
// The per-FACT mint gates, the S-CONFLATE and S-NUMERIC detectors, the Gate B derived coverage, the null-tier host aggregate and
// the ONE writer of item_gate_a_state (INV-057).
import { isDerivedConsistent } from "@/core/brief/timeline";
import { isVerbatim } from "@/core/contracts";
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";
import { containsNumeral, figuresEqual, findFigures, findIdentifiers, isFigure, mentionsIdentifier, resolveLocale } from "@/core/parse";

import { GATE_A_VERSION, md5, norm, scanGateA } from "./gate-a-scan";

// ---- defect signatures ----------------------------------------------------------------------------------------
export const REUSE_MIN = 3;
const NAMED_ACTS = ["CountEmissions", "FuelEU", "ReFuelEU", "CBAM", "EUDR", "AFIR", "CSRD", "ESRS", "EPBD", "MEES", "PPWR"];
interface FactLike { idx?: number; id?: string | number | null; claim_text?: string | null; source_span?: string | null }
export interface DefectHit { idx?: number | undefined; id?: string | number | null | undefined; signature: "S-CONFLATE" | "S-NUMERIC"; rationale: string }

/** Instrument and standard identifiers named in a claim, as normalised keys (EU number, CELEX and print forms of one act are one key), and the named acts. */
export function extractIdentifiers(claim: string | null | undefined): Set<string> {
  const c = String(claim || "");
  const ids = new Set<string>();
  for (const f of findIdentifiers(c)) if (f.kind === "instrument" || f.kind === "standard") ids.add(f.key);
  for (const name of NAMED_ACTS) if (new RegExp(`\\b${name}`, "i").test(c)) ids.add(`NAME:${name.toLowerCase()}`);
  return ids;
}
/** Does the span name this identifier? By EQUALITY on the normalised key: 2019/88 is not in a span that says 2019/883. */
function spanHasIdentifier(span: string, id: string): boolean {
  return id.startsWith("NAME:") ? span.toLowerCase().includes(id.slice(5)) : mentionsIdentifier(span, { key: id, type: null });
}
/** S-CONFLATE: one span reused by REUSE_MIN or more FACTs naming two or more distinct instruments, some absent from the span. */
export function detectConflate(facts: FactLike[]): DefectHit[] {
  const groups = new Map<string, FactLike[]>();
  for (const f of facts) {
    const key = String(f.source_span || "").trim();
    if (key) groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const hits: DefectHit[] = [];
  for (const [span, group] of groups) {
    if (group.length < REUSE_MIN) continue;
    const ids = new Set<string>();
    for (const f of group) for (const id of extractIdentifiers(f.claim_text)) ids.add(id);
    const absent = [...ids].filter((id) => !spanHasIdentifier(span, id));
    if (ids.size < 2 || !absent.length) continue;
    const rationale = `span reused by ${group.length} FACT claims naming {${[...ids].join(", ")}}; absent from span: {${absent.join(", ")}}`;
    for (const f of group) hits.push({ idx: f.idx, id: f.id, signature: "S-CONFLATE", rationale });
  }
  return hits;
}
const OBLIGATION_YEAR = /\b(?:from|by|before|until|effective|deadline|starting)\s+(?:\d{1,2}\s+\w+\s+)?(20\d{2})\b/gi;
/**
 * S-NUMERIC: every typed figure of the claim must be stated, as an EQUAL figure (value, unit, scale: @/core/parse), in its span, and an obligation year must stand in the span at a numeral
 * boundary. A figure the parser refuses is a miss (unreadable is not absent): the claim and its span are one document, read under one locale.
 */
export function detectNumeric(fact: FactLike): DefectHit | null {
  const [claim, span] = [String(fact.claim_text || ""), String(fact.source_span || "")];
  const verdict = resolveLocale(`${claim}\n${span}`);
  const stated = findFigures(span, { verdict }).flatMap((h) => (isFigure(h.result) ? [h.result] : []));
  const hit = (rationale: string): DefectHit => ({ idx: fact.idx, id: fact.id, signature: "S-NUMERIC", rationale });
  for (const h of findFigures(claim, { verdict })) {
    if (!isFigure(h.result)) return hit(`figure "${h.result.literal}" cannot be read: ${h.result.reason}`);
    const f = h.result;
    if (!stated.some((s) => figuresEqual(s, f))) return hit(`figure "${f.literal}" (value ${f.value}, ${f.unit}) not stated in span`);
  }
  for (const m of claim.matchAll(OBLIGATION_YEAR)) if (!containsNumeral(span, m[1] ?? "")) return hit(`obligation year "${m[1]}" not stated in span`);
  return null;
}

// ---- mint gates -----------------------------------------------------------------------------------------------
export interface GateFact { id?: string; claim_kind: string; claim_text: string | null; source_span: string | null; source_id: string | null; source_tier_at_grounding: number | null }
export interface PerFactGates { genericSource: boolean; authorityFloor: boolean; spanNumeric: boolean }
/** Per-FACT gates (true = would have held): no specific source, below the per-type floor, a figure absent from the span. */
export function perFactGates(fact: GateFact, ctx: { itemFloor: number | null; suspendedSourceIds?: Iterable<string> }): PerFactGates | null {
  if (!fact || String(fact.claim_kind).toUpperCase() !== "FACT") return null;
  const susp = new Set(ctx.suspendedSourceIds ?? []);
  return {
    genericSource: fact.source_id == null || susp.has(fact.source_id),
    authorityFloor: ctx.itemFloor != null && fact.source_tier_at_grounding != null && fact.source_tier_at_grounding > ctx.itemFloor,
    spanNumeric: !!detectNumeric({ id: fact.id ?? null, claim_text: fact.claim_text, source_span: fact.source_span }),
  };
}
/** Item-level S-CONFLATE: the ids of the FACTs that identity congruence would hold. */
export function identityCongruenceHolds(facts: GateFact[]): Set<string | number | null | undefined> {
  const list = (facts ?? []).filter((f) => String(f.claim_kind).toUpperCase() === "FACT").map((f, i) => ({ idx: i + 1, id: f.id ?? i + 1, claim_text: f.claim_text, source_span: f.source_span }));
  return new Set(detectConflate(list).map((h) => h.id));
}
export interface MintGateReport { conflateHeldIds: string[]; numericHeldIds: string[]; numericFacts: GateFact[]; belowFloor: number; genericSource: number }
/** All four mint gates over the FACTs a ground added or changed: the HARD hold ids (S-CONFLATE and S-NUMERIC: a figure the span does not state is a hold, not a flag), the facts behind the numeric holds, the counts already enforced elsewhere. */
export function mintGates(facts: GateFact[], ctx: { itemFloor: number | null; suspendedSourceIds?: Iterable<string> }): MintGateReport {
  const gated = facts.map((f) => perFactGates(f, ctx));
  return {
    conflateHeldIds: [...identityCongruenceHolds(facts)].filter((x): x is string => typeof x === "string"),
    numericHeldIds: facts.filter((f, i) => gated[i]?.spanNumeric && typeof f.id === "string").map((f) => f.id as string),
    numericFacts: facts.filter((_, i) => gated[i]?.spanNumeric),
    belowFloor: gated.filter((g) => g?.authorityFloor).length,
    genericSource: gated.filter((g) => g?.genericSource).length,
  };
}

// ---- Gate A state: the one writer, and the Gate B derived coverage ----------------------------------------------
export interface GateARow { intelligence_item_id: string; scanned_hash: string; orphan_count: number; orphans: unknown[]; gate_a_version: string; scanned_at: string }
/** The item_gate_a_state row every writer builds (the SAME scanner, the SAME six fields). Pure. */
export function buildGateARow(a: { itemId: string; fullBrief: string | null | undefined; factClaims: { claim_text: string; source_span: string }[]; derivedCovered?: Set<string>; nowIso: string }): GateARow {
  const ga = scanGateA(a.fullBrief ?? "", a.factClaims, a.derivedCovered);
  return { intelligence_item_id: a.itemId, scanned_hash: ga.scanned_hash, orphan_count: ga.orphan_count, orphans: ga.orphans, gate_a_version: ga.gate_a_version, scanned_at: a.nowIso };
}
export { GATE_A_VERSION, md5 };
export interface CitationEdgeRow { intelligence_item_id: string; source_id: string; detected_at: string; origin: "agent_extraction" }
/** intelligence_item_citations edge rows for a DISTINCT set of cited source ids (one shape, every writer). Pure; drops falsy ids. */
export function buildCitationEdges(itemId: string, sourceIds: Iterable<string | null | undefined>, nowIso: string): CitationEdgeRow[] {
  const ids = new Set<string>();
  for (const id of sourceIds) if (id) ids.add(id);
  return [...ids].map((source_id) => ({ intelligence_item_id: itemId, source_id, detected_at: nowIso, origin: "agent_extraction" as const }));
}
/** INV-057: item_gate_a_state has exactly this writer. An upsert on the item; a failure is returned, never swallowed. */
export async function upsertGateAState(sb: Db, row: GateARow): Promise<{ error: string | null }> {
  const { error } = await sb.from("item_gate_a_state").upsert(row, { onConflict: "intelligence_item_id" });
  return { error: error ? error.message : null };
}
/** Fail-closed blanking of the state when a reconcile cannot complete: criterion 7's missing-state arm then quarantines the item. */
export async function clearGateAState(sb: Db, itemId: string): Promise<{ error: string | null }> {
  const { error } = await sb.from("item_gate_a_state").delete().eq("intelligence_item_id", itemId);
  return { error: error ? error.message : null };
}

/**
 * The derived tokens (normalised) currently covered for an item: a DERIVED claim whose FACT basis still holds (its span is still
 * verbatim in its capture, case-insensitive like criterion 3) AND whose date follows arithmetically from the basis' recurring rule.
 * Every read destructures its error (a read that fails throws; it once read as "nothing covered").
 */
export async function derivedCoveredTokens(sb: Db, itemId: string): Promise<Set<string>> {
  const covered = new Set<string>();
  const derived = await fetchAllRows<{ claim_text: string | null; basis_claim_id: string | null }>((from, to) => sb.from("section_claim_provenance").select("claim_text, basis_claim_id").eq("intelligence_item_id", itemId).eq("claim_kind", "DERIVED").order("id", { ascending: true }).range(from, to), { cap: 20_000 });
  const basisIds = [...new Set(derived.map((x) => x.basis_claim_id).filter((x): x is string => !!x))];
  if (!basisIds.length) return covered;
  const bases = await fetchAllByIdChunks(basisIds, async (slice) => {
    const r = await sb.from("section_claim_provenance").select("id, source_span, search_result_id").in("id", slice).eq("claim_kind", "FACT");
    if (r.error) throw new LookupError("section_claim_provenance (basis)", r.error);
    return (r.data ?? []) as { id: string; source_span: string | null; search_result_id: string | null }[];
  });
  const srIds = [...new Set(bases.map((b) => b.search_result_id).filter((x): x is string => !!x))];
  const caps = await fetchAllByIdChunks(srIds, async (slice) => {
    const r = await sb.from("agent_run_searches").select("id, result_content").in("id", slice);
    if (r.error) throw new LookupError("agent_run_searches (basis captures)", r.error);
    return (r.data ?? []) as { id: string; result_content: string | null }[];
  });
  const capById = new Map(caps.map((c) => [c.id, c.result_content ?? ""]));
  const baseById = new Map(bases.map((b) => [b.id, b]));
  for (const x of derived) {
    const b = x.basis_claim_id ? baseById.get(x.basis_claim_id) : undefined;
    const cap = b?.search_result_id ? capById.get(b.search_result_id) : undefined;
    if (!b?.source_span || !isVerbatim(cap, b.source_span)) continue;
    if (!isDerivedConsistent(b.source_span, x.claim_text ?? "")) continue;
    covered.add(norm(x.claim_text ?? ""));
  }
  return covered;
}

// ---- null-tier host aggregate (register and rate, rule 18) ---------------------------------------------------------
export interface NullTierAggregate { perItemFacts: Record<string, number>; sampleSpans: string[] }
const MAX_SAMPLES = 5;
/** Merge one item's null-tier contribution for a host into the open aggregate (idempotent per item: this item's count REPLACES its prior value). */
export function mergeNullTierAggregate(existing: NullTierAggregate | null | undefined, itemId: string, contribution: { factCount: number; samples: string[] }): NullTierAggregate {
  const sampleSpans = [...(existing?.sampleSpans ?? [])];
  for (const s of contribution.samples ?? []) if (sampleSpans.length < MAX_SAMPLES && s && !sampleSpans.includes(s)) sampleSpans.push(s);
  return { perItemFacts: { ...(existing?.perItemFacts ?? {}), [itemId]: contribution.factCount }, sampleSpans };
}
/**
 * The flag text for a host whose FACT spans resolve to a null tier, in its two shapes. A host that is NOT ruled never-registerable
 * is REGISTERED AND RATED (rule 18: the source is found and rated, never the figure refused; the old text told the operator to
 * relabel). A ruled aggregator or platform is re-attributed to the real publisher, never registered.
 */
export function summarizeNullTierAggregate(host: string, agg: NullTierAggregate, permanentClass: "aggregator" | "platform" | null = null): { itemCount: number; factCount: number; description: string; action: string; rationale: string } {
  const itemCount = Object.keys(agg.perItemFacts).length;
  const factCount = Object.values(agg.perItemFacts).reduce((a, b) => a + b, 0);
  const spans = `${factCount} FACT span(s) across ${itemCount} item(s)`;
  if (permanentClass) {
    const what = permanentClass === "aggregator" ? "republishes text it did not publish" : "hosts a publication it did not publish";
    return {
      itemCount, factCount,
      description: `Re-attribution required for ${host} (ruled ${permanentClass}, never registerable): ${spans} resolve to NULL tier. It ${what}, so it is not the publisher; any tier would credit it with the publisher's authority. Fix the SPAN not the registry: re-attribute to the real publisher. Floor-subject only for CRITICAL/HIGH non-exempt items.`,
      action: "reattribute_to_publisher",
      rationale: `${host} is a ruled ${permanentClass} and stays UNREGISTERED permanently; ${spans} currently NULL-stamp against it. Re-attribute each span to the publisher the host reproduced. Do not register this host.`,
    };
  }
  return {
    itemCount, factCount,
    description: `Unregistered host ${host}: ${spans} resolve to NULL tier (host not in the sources registry). Register and rate it from the institution class table (rule 18); the figure is published with that source's rating, never refused. Floor-subject only for CRITICAL/HIGH non-exempt items.`,
    action: "register_and_rate_source",
    rationale: `Register ${host} through the registry (tier from the institution class table), capture the page, ground the span on it; ${spans} currently NULL-stamp.`,
  };
}
