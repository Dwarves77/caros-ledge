// Ported from old_repo/src/lib/intake/mint-item.ts (lines 20-266)
// The gates in front of the one insert, in order: idempotency probes, congruence 1a/1b, subject dedup over the FULL non-archived corpus, the relevance floor, the
// domain and format_type derivations, and the source-link invariant. Every probe is FAIL-CLOSED: a read error refuses the mint, never reads as "no duplicate" (INV-169,
// B-0267/B-1988: the old corpus read had no range and no order, so dedup saw at most the first 1,000 rows). `dry` and `apply` share this whole function.
import type { Db } from "@/core/db";
import { boundedRead, fetchAllRows } from "@/core/db";
import { specForItemType } from "@/core/brief";
import { readSourceByUrl } from "@/core/sources";
import { domainForItemType, type Domain } from "@/core/shared/domains";

import type { CorpusRow, EntityDeps } from "./deps";
import { buildHeldIndex, isHeld } from "./select";
import type { Holder, MintOutcome } from "./types";

/** Fork-4 relevance floor (0-100). Surface-only: below it a flag opens and the item mints anyway. */
export const RELEVANCE_FLOOR = 40;
const HOLDER_COLUMNS = "id, source_url, canonical_instrument_key, instrument_identifier, archive_reason";
const CATEGORIES = [null, "regulatory", "research", "market_news", "operational_data"] as const;

/** The domain an item type decides ALONE (the same answer for every source category), or null for a conditional type (framework, tool, initiative). */
export function unconditionalDomain(itemType: string | null | undefined): Domain | null {
  const all = CATEGORIES.map((c) => domainForItemType(itemType, c));
  return all[0] != null && all.every((d) => d === all[0]) ? all[0] : null;
}
/** Surface-routing guard: the canonical domain when the current one disagrees (or is absent) for an unconditional type, else null. */
export function canonicalDomainOverride(itemType: string | null | undefined, current: unknown): Domain | null {
  const d = unconditionalDomain(itemType);
  return d != null && current !== d ? d : null;
}

export type SourceLinkOutcome = { kind: "preset" } | { kind: "link"; sourceId: string } | { kind: "reject"; error: string };
/** A mint cannot produce a source-less LIVE item (grounding grounds against the item's source): trust a preset source_id, link a registered one, else reject. */
export function sourceLinkDecision(seed: { source_id?: unknown; source_url?: unknown }, matchedSourceId: string | null): SourceLinkOutcome {
  if (seed.source_id != null) return { kind: "preset" };
  const url = String(seed.source_url ?? "");
  if (!url) return { kind: "reject", error: "no source_url and no source_id: a live item cannot mint without a source (source-link invariant)" };
  return matchedSourceId ? { kind: "link", sourceId: matchedSourceId } : { kind: "reject", error: `no registered source for ${url}: register the source first (source-link invariant)` };
}

export interface GatePlan {
  seed: Record<string, unknown>;
  legacyId?: string | null | undefined;
  relevance?: number | null | undefined;
  grade?: "brief" | "record" | undefined;
}
export type GateResult =
  | { stop: false; seed: Record<string, unknown>; flags: string[]; linkTargetId: string | null; retyped: boolean; seekStudy: boolean; lowRelevance: number | null }
  | { stop: true; outcome: MintOutcome; itemId: string | null; flags: string[]; error: string };

const refuse = (outcome: MintOutcome, flags: string[], error: string, itemId: string | null = null): GateResult => ({ stop: true, outcome, itemId, flags, error });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function holdersWhere(sb: Db, column: "source_url" | "canonical_instrument_key" | "legacy_id", value: string): Promise<{ rows: Holder[] } | { error: string }> {
  const r = await boundedRead<Holder>((limit) => sb.from("intelligence_items").select(HOLDER_COLUMNS).eq(column, value).limit(limit) as never, { limit: 200 });
  if (r.error) return { error: r.error.message };
  return r.truncated ? { error: `more than ${r.data.length} holders of ${column}; refusing to guess` } : { rows: r.data };
}

/** Run every gate against live state. Returns the (possibly retyped, re-domained) seed and the decisions taken, or the stop that refuses the mint. */
export async function runGates(sb: Db, entities: EntityDeps, plan: GatePlan): Promise<GateResult> {
  const flags: string[] = [];
  const seed: Record<string, unknown> = { ...plan.seed };
  const sourceUrl = String(seed.source_url ?? "");
  const key = typeof seed.canonical_instrument_key === "string" && seed.canonical_instrument_key ? seed.canonical_instrument_key : null;
  if (seed.item_grade == null) seed.item_grade = plan.grade ?? "brief";

  // Idempotency (INV-293): the URL with the same instrument identity is the same document; a different labelled identifier at that URL is a sibling and proceeds.
  if (sourceUrl) {
    const h = await holdersWhere(sb, "source_url", sourceUrl);
    if ("error" in h) return refuse("duplicate", flags, `mint refused (fail-closed): source_url probe read failed: ${h.error}`);
    const hit = isHeld({ url: sourceUrl, key: null, instrumentIdentifier: seed.instrument_identifier as string | null | undefined }, buildHeldIndex(h.rows));
    if (hit.held) return { stop: true, outcome: "exists", itemId: hit.holderId, flags, error: "source_url already held with the same instrument identity" };
  }
  if (plan.legacyId) {
    const h = await holdersWhere(sb, "legacy_id", plan.legacyId);
    if ("error" in h) return refuse("duplicate", flags, `mint refused (fail-closed): legacy_id probe read failed: ${h.error}`);
    if (h.rows[0]) return { stop: true, outcome: "exists", itemId: h.rows[0].id, flags, error: "legacy_id already minted" };
  }
  if (key) {
    const h = await holdersWhere(sb, "canonical_instrument_key", key);
    if ("error" in h) return refuse("duplicate", flags, `mint refused (fail-closed): canonical key probe read failed: ${h.error}`);
    const hit = isHeld({ url: null, key, instrumentIdentifier: null }, buildHeldIndex(h.rows));
    if (hit.held) return refuse("duplicate", flags, `canonical key ${key} is already held by ${hit.holderId}${hit.archived ? " (archived)" : ""}: not minting a duplicate`);
  }

  // (1) congruence: 1a retypes a primary-artifact type on news to market_signal; 1b keeps research_finding and seeks the study.
  const cong = entities.congruence(seed.item_type as string | undefined, sourceUrl);
  let seekStudy = false;
  if (cong.changed) {
    seed.item_type = cong.itemType;
    if (seed.domain === 1) seed.domain = 4;
    flags.push("congruence:1a");
  } else if (cong.incongruentSource) {
    seekStudy = true;
    flags.push("seek-study:1b");
  }

  // (2) subject-existence dedup over the FULL non-archived corpus, every page, in a total order (a read error refuses).
  let corpus: CorpusRow[];
  try {
    corpus = await fetchAllRows<CorpusRow>((from, to) => sb.from("intelligence_items").select("id, title, instrument_identifier, source_url").eq("is_archived", false).order("id", { ascending: true }).range(from, to) as never, { cap: 500_000 });
  } catch (e) {
    return refuse("duplicate", flags, `mint refused (fail-closed): dedup corpus read failed: ${msg(e)}`);
  }
  const dups = entities.matchExistingSubject(seed, corpus);
  let linkTargetId: string | null = null;
  if (dups.length) {
    if (entities.sourceRole(sourceUrl) !== "news") return refuse("duplicate", flags, `dedup: subject already exists as ${dups.slice(0, 3).map((d) => `${d.id}(${d.how})`).join(", ")}: not minting a duplicate`);
    if (seed.item_type !== "market_signal") {
      seed.item_type = "market_signal";
      if (seed.domain === 1) seed.domain = 4;
    }
    linkTargetId = dups[0]?.id ?? null;
    flags.push("dedup:linked");
  }

  // (4) relevance: fail-open, surface-only.
  const lowRelevance = plan.relevance != null && plan.relevance < RELEVANCE_FLOOR ? plan.relevance : null;
  if (lowRelevance != null) flags.push("low-relevance");

  // (5) domain, keyed on the FINAL item_type; (5b) format_type through the same registry generation forces.
  const canon = canonicalDomainOverride(seed.item_type as string | undefined, seed.domain);
  if (canon != null) {
    flags.push(`domain-canonicalized:${String(seed.domain ?? "null")}->${canon}`);
    seed.domain = canon;
  }
  if (seed.format_type == null) {
    const spec = specForItemType(seed.item_type as string | undefined);
    if (spec) seed.format_type = spec.formatType;
  }

  // (6) source-link invariant: the last gate before the insert. A registry read error refuses.
  let matched: string | null = null;
  if (seed.source_id == null && sourceUrl) {
    try {
      matched = (await readSourceByUrl(sb, sourceUrl))?.id ?? null;
    } catch (e) {
      return refuse("unsourced", flags, `mint refused (fail-closed): source registry probe read failed: ${msg(e)}`);
    }
  }
  const link = sourceLinkDecision(seed, matched);
  if (link.kind === "reject") return refuse("unsourced", flags, link.error);
  if (link.kind === "link") {
    seed.source_id = link.sourceId;
    flags.push("source-linked");
  }
  return { stop: false, seed, flags, linkTargetId, retyped: cong.changed, seekStudy, lowRelevance };
}
