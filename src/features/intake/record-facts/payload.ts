// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 845-1010)
// Ported from old_repo/src/lib/intake/record-facts-research.mjs (lines 193-277)
// The record-grade mint payload: the stub full_brief (built only from claim text with digit-free boilerplate, so it can never add an
// ungrounded Gate A token; a body carrying an internal marker is refused) and the payload shape the write sequence consumes. The
// research profile is the same builder over the research_finding item type: its three always-present signals and its unified trigger
// table come from buildRecordFacts, so there is no second append and no duplicate claim for the evidence and authority slots.
import { assertNoInternalMarkers } from "@/core/brief/sections";

import { buildRecordFacts, type RecordClaim } from "./extract";
import { RESEARCH_FINDING_REQUIRED_SLOTS } from "./triggers";

/** The marker a stub catalogue record opens with: the ONE string a consumer checks to tell a stub from a full brief. */
export const STUB_BRIEF_MARKER = "Catalogue record: extracted facts only, full brief pending.";

/** item.full_brief for a record-grade payload: boilerplate plus each claim's own text, FACTs first then GAPs. */
export function buildRecordFullBrief(a: { sourceUrl: string; claims: RecordClaim[] }): string {
  const lines = (kind: "FACT" | "GAP") => a.claims.filter((c) => c.claim_kind === kind).map((c) => `- ${c.claim_text}`);
  const facts = lines("FACT");
  const gaps = lines("GAP");
  const parts = [`*${STUB_BRIEF_MARKER}*`];
  if (facts.length) parts.push("", "## Verbatim facts", "", ...facts);
  if (gaps.length) parts.push("", "## Not stated in the captured source", "", ...gaps);
  parts.push("", `Source: ${a.sourceUrl}`);
  return assertNoInternalMarkers(parts.join("\n"), "buildRecordFullBrief");
}

export interface RecordPayloadInput {
  sourceUrl: string;
  itemType: string;
  title: string;
  instrumentIdentifier?: string | null;
  canonicalInstrumentKey?: string | null;
  jurisdictionIso?: string | null;
  priority?: string;
  source: { id: string; [k: string]: unknown };
  capturedText: string;
  fetchedLength?: number;
  requiredSlots?: readonly string[];
  screen?: { verdict: string; provenance: string; basis: string } | null;
}
export interface RecordPayload {
  item: Record<string, unknown>;
  source: RecordPayloadInput["source"];
  screen: RecordPayloadInput["screen"];
  registry_sources: unknown[];
  sections: { section_key: string; section_order: number; content_md: string }[];
  search_results: { result_url: string; result_title: string; search_query: string; result_index: number; result_content: string; fetched_length: number }[];
  claims: RecordClaim[];
}

/** A complete record-grade payload from one already-captured document. Pure: the captured text is resolved by the caller. */
export function buildRecordPayload(a: RecordPayloadInput): RecordPayload {
  if (!a.sourceUrl) throw new Error("record-facts: buildRecordPayload requires sourceUrl");
  if (!a.itemType) throw new Error("record-facts: buildRecordPayload requires itemType");
  if (!a.title) throw new Error("record-facts: buildRecordPayload requires title");
  if (!a.source?.id) throw new Error("record-facts: buildRecordPayload requires a registered source (source.id)");
  if (typeof a.capturedText !== "string" || a.capturedText.trim() === "") throw new Error("record-facts: buildRecordPayload requires non-empty capturedText");
  const claims = buildRecordFacts({ title: a.title, sourceUrl: a.sourceUrl, capturedText: a.capturedText, requiredSlots: a.requiredSlots ?? [], itemType: a.itemType });
  const text = (section: string) => claims.filter((c) => c.section_key === section).map((c) => c.claim_text).join("\n");
  const sections = [
    ...(claims.some((c) => c.section_key === "identity") ? [{ section_key: "identity", section_order: 1, content_md: text("identity") }] : []),
    { section_key: "record_facts", section_order: 2, content_md: text("record_facts") },
    { section_key: "sources_and_citations", section_order: 3, content_md: `Source: ${a.sourceUrl}` },
  ];
  return {
    item: {
      source_url: a.sourceUrl, item_type: a.itemType, priority: a.priority ?? "MODERATE", title: a.title,
      instrument_identifier: a.instrumentIdentifier ?? null, canonical_instrument_key: a.canonicalInstrumentKey ?? null,
      jurisdiction_iso: a.jurisdictionIso ?? null, full_brief: buildRecordFullBrief({ sourceUrl: a.sourceUrl, claims }), grade: "record",
    },
    source: a.source,
    screen: a.screen ?? null,
    registry_sources: [],
    sections,
    search_results: [{ result_url: a.sourceUrl, result_title: a.title, search_query: "canonical:record-grade", result_index: 0, result_content: a.capturedText, fetched_length: typeof a.fetchedLength === "number" ? a.fetchedLength : a.capturedText.length }],
    claims,
  };
}

/** The research profile: finding, methodology limits, decision relevance, what it does not resolve, plus the key figure and the two credibility signals. */
export function buildResearchRecordPayload(a: Omit<RecordPayloadInput, "itemType">): RecordPayload {
  return buildRecordPayload({ ...a, itemType: "research_finding", requiredSlots: a.requiredSlots ?? RESEARCH_FINDING_REQUIRED_SLOTS });
}
