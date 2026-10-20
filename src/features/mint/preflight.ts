// Ported from old_repo/scripts/mint/validate-mint-payload.mjs (lines 24-292)
// Ported from old_repo/scripts/mint/validate-mint-payload.mjs (lines 373-492)
// Ported from old_repo/scripts/mint/validate-mint-payload.mjs (lines 600-640)
// Ported from old_repo/scripts/mint/lib/tag-presence-check.mjs (lines 1-70)
// The kit checks the database does NOT have, run on a payload before any write: capture completeness, unicode integrity (a hand-transcribed x for a multiplication
// sign), record purity, record_hollow (with the series exemption), and a present on_vertical screen verdict. The JavaScript replica of validate_item_provenance C1-C7
// is gone (ruling 2): the database function is the one gate, read back after the write. A criterion-5 `record_hollow` stays criterion 5 so the hold reads
// `validation_failed:5:record_hollow` and a reopen by that reason still finds it.
import { z } from "zod";

import data from "./data/preflight.json";
import type { RecordPayload } from "./types";

const Data = z.object({
  capture: z.object({ tolerance_chars: z.number(), completeness_floor: z.number() }),
  unicode_classes: z.array(z.object({ name: z.string(), chars: z.array(z.string().length(1)).min(2) })),
  signature_tag_fields: z.array(z.string()).length(3),
  screen_provenance: z.array(z.string()),
});
const cfg = Data.parse(data);
const CLASS_OF = new Map(cfg.unicode_classes.flatMap((c) => c.chars.map((ch) => [ch, c.name] as const)));
const CANON = new Map(cfg.unicode_classes.map((c) => [c.name, c.chars[0] ?? ""]));

export interface Failure { criterion: number | "kit"; reason: string; [k: string]: unknown }
export interface Warning { field: string; reason: string }
export interface PreflightResult { ok: boolean; failures: Failure[]; warnings: Warning[] }
type Result = RecordPayload["search_results"][number] & { archived_source_text?: string };

/** The captured text must be the whole fetched document: within the tolerance of the fetched length, and never under the completeness floor (INV-296). */
function captureCompleteness(r: Result, index: number): Failure[] {
  const base = { criterion: "kit" as const, result_index: index, result_url: r.result_url ?? null };
  const len = String(r.result_content ?? "").length;
  const fetched = r.fetched_length;
  if (typeof fetched !== "number" || !Number.isFinite(fetched) || fetched < 0) return [{ ...base, reason: "missing_fetched_length" }];
  const diff = len - fetched;
  if (Math.abs(diff) <= cfg.capture.tolerance_chars) return [];
  if (diff > 0) return [{ ...base, reason: "capture_length_exceeds_fetched", result_content_length: len, fetched_length: fetched }];
  const ratio = fetched === 0 ? 1 : len / fetched;
  return [{ ...base, reason: ratio < cfg.capture.completeness_floor ? "capture_incomplete" : "capture_length_mismatch", result_content_length: len, fetched_length: fetched, ratio: Number(ratio.toFixed(4)) }];
}

const nfkc = (s: unknown) => String(s ?? "").normalize("NFKC");
/** NFKC, lower-case, then every substitution-class character mapped to its class's canonical member (each class member is one character: positions are preserved). */
function fold(s: string): string {
  let out = "";
  for (const ch of nfkc(s).toLowerCase()) out += CANON.get(CLASS_OF.get(ch) ?? "") ?? ch;
  return out;
}
interface Compared { strict: boolean; fuzzy: boolean; substitution: { class: string; span_char: string; reference_char: string; window: string } | null }
interface Ref { raw: string; lower: string; folded: string }
const prepare = (raw: string): Ref => ({ raw, lower: raw.toLowerCase(), folded: fold(raw) });
function compare(span: string, ref: Ref): Compared {
  const s = span.trim();
  const reference = ref.raw;
  const strict = s.length > 0 && ref.lower.includes(s.toLowerCase());
  const at = s.length > 0 ? ref.folded.indexOf(fold(s)) : -1;
  let substitution: Compared["substitution"] = null;
  if (!strict && at !== -1) {
    const window = reference.slice(at, at + s.length);
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === window[i] || s[i]?.toLowerCase() === window[i]?.toLowerCase()) continue;
      const cls = CLASS_OF.get(s[i] ?? "") ?? CLASS_OF.get(window[i] ?? "");
      if (cls) {
        substitution = { class: cls, span_char: s[i] ?? "", reference_char: window[i] ?? "", window };
        break;
      }
    }
  }
  return { strict, fuzzy: at !== -1, substitution };
}
/** A FACT span that matches its capture only after folding (or only the archived reference lacks it) is a transcription slip, named with the class and the characters. */
function unicodeIntegrity(claim: RecordPayload["claims"][number], r: Result, haystack: string): Failure[] {
  const span = claim.source_span;
  if (!span || !span.trim()) return [];
  const archived = typeof r.archived_source_text === "string" ? r.archived_source_text : null;
  const cmp = compare(span, prepare(archived ?? haystack));
  if (archived != null && compare(span, prepare(haystack)).strict && !cmp.strict) return [{ criterion: "kit", reason: "fact_span_matches_payload_only_not_archive", claim: claim.claim_text, source_span: span, substitution: cmp.substitution }];
  if (cmp.strict) return [];
  const reference = archived != null ? "archived_source" : "result_content";
  if (cmp.substitution) return [{ criterion: "kit", reason: "fact_span_unicode_substitution", claim: claim.claim_text, source_span: span, substitution_class: cmp.substitution.class, span_char: cmp.substitution.span_char, source_char: cmp.substitution.reference_char, reference }];
  return cmp.fuzzy ? [{ criterion: "kit", reason: archived != null ? "fact_span_not_in_archived_source" : "fact_span_unicode_normalization_mismatch", claim: claim.claim_text, source_span: span, reference }] : [];
}
/** The same slip anywhere in authored prose: a substitution-class character whose 30-character window matches the reference only after folding. */
function proseSubstitutions(text: string | null | undefined, reference: Ref, label: string): Failure[] {
  const t = String(text ?? "");
  const out: Failure[] = [];
  for (let i = 0; i < t.length && reference.raw; i += 1) {
    if (!CLASS_OF.has(t[i] ?? "")) continue;
    const cmp = compare(t.slice(Math.max(0, i - 30), i + 30), reference);
    if (!cmp.strict && cmp.fuzzy && cmp.substitution) out.push({ criterion: "kit", reason: "prose_unicode_substitution", location: label, substitution_class: cmp.substitution.class, prose_char: cmp.substitution.span_char, source_char: cmp.substitution.reference_char });
  }
  return out;
}

/** Empty signature-tag arrays are visible, never a refusal: an item with no tags scores no connection edge, and inventing a tag is forbidden. */
function tagPresence(payload: Pick<RecordPayload, "item">): Warning[] {
  const item = payload.item ?? {};
  const empty = cfg.signature_tag_fields.filter((f) => !Array.isArray(item[f]) || (item[f] as unknown[]).length === 0);
  const out = empty.map((field) => ({ field, reason: `payload.item.${field} is empty or absent: the item mints with no ${field} value and cannot score that connection basis` }));
  return empty.length === cfg.signature_tag_fields.length ? [...out, { field: "*", reason: "all three connection-signature tag fields are empty: the item scores no discovery edge at mint" }] : out;
}

/** Run every kit check on one payload. `ok` is false when any failure is present; warnings never block. */
export function preflight(payload: RecordPayload, opts: { isSeriesKey: (identifier: string | null | undefined) => boolean }): PreflightResult {
  const failures: Failure[] = [];
  const item = payload.item ?? {};
  const claims = payload.claims ?? [];
  const results = (payload.search_results ?? []) as Result[];
  const keys = new Set((payload.sections ?? []).map((s) => s.section_key));
  for (const c of claims) if (!keys.has(c.section_key)) failures.push({ criterion: "kit", reason: "claim_references_unknown_section_key", claim: c.claim_text, section_key: c.section_key });

  if (item.grade === "record") {
    for (const c of claims) if (c.claim_kind !== "FACT" && c.claim_kind !== "GAP") failures.push({ criterion: "kit", reason: "record_grade_forbidden_claim_kind", claim: c.claim_text, claim_kind: c.claim_kind });
    const brief = String(item.full_brief ?? "").toLowerCase();
    for (const c of claims) if (c.claim_kind === "FACT" && c.source_span?.trim() && !brief.includes(c.source_span.trim().toLowerCase())) failures.push({ criterion: "kit", reason: "record_grade_full_brief_not_extractive", claim: c.claim_text, source_span: c.source_span });
    // Hollow: a record whose only FACT is the title (or none) carries no extracted information. A registered market series is exempt (its substance is the series rows).
    const substantive = claims.filter((c) => c.claim_kind === "FACT" && !c.claim_text.trim().toLowerCase().startsWith("[title]")).length;
    const seriesBacked = item.item_type === "market_signal" && opts.isSeriesKey(item.instrument_identifier as string | null);
    if (substantive === 0 && !seriesBacked) failures.push({ criterion: 5, reason: "record_hollow", fact_count: claims.filter((c) => c.claim_kind === "FACT").length });
    const s = payload.screen;
    if (!s || !s.verdict || !String(s.basis ?? "").trim() || !cfg.screen_provenance.includes(s.provenance)) failures.push({ criterion: "kit", reason: "screen_verdict_missing", screen: s ?? null });
    else if (s.verdict !== "on_vertical") failures.push({ criterion: "kit", reason: "screen_verdict_not_on_vertical", verdict: s.verdict, basis: s.basis });
  }

  results.forEach((r, i) => failures.push(...captureCompleteness(r, i)));
  const byUrl = new Map(results.map((r) => [String(r.result_url ?? "").toLowerCase(), r]));
  for (const c of claims) {
    const r = c.claim_kind === "FACT" && c.source_url ? byUrl.get(c.source_url.toLowerCase()) : undefined;
    if (r) failures.push(...unicodeIntegrity(c, r, r.result_content));
  }
  const primary = item.source_url ? byUrl.get(String(item.source_url).toLowerCase()) : undefined;
  if (primary) {
    const ref = prepare(primary.archived_source_text ?? primary.result_content);
    for (const [label, text] of [["full_brief", item.full_brief as string], ...(payload.sections ?? []).map((s) => [`section:${s.section_key}`, s.content_md] as const)] as const) failures.push(...proseSubstitutions(text, ref, label));
  }
  return { ok: failures.length === 0, failures, warnings: tagPresence(payload) };
}
