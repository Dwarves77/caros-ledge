// Ported from old_repo/src/lib/contracts/verbatim-grounding.mjs (lines 14-31)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 14-25)
// The ONE verbatim rule. It mirrors validate_item_provenance criterion 3 exactly (supabase/schema.sql 6126-6128):
//   position(lower(btrim(source_span)) IN lower(result_content)) > 0
// btrim trims spaces only (U+0020), not tabs or newlines; a null capture or an empty span never matches.
// Producers and record-facts use this and no second rule, so a span accepted here clears the database gate.

const SPACE = /^ +| +$/g;

/** True when `span` is, after trimming spaces, a case-insensitive substring of `capture`. */
export function isVerbatim(capture: string | null | undefined, span: string | null | undefined): boolean {
  if (capture == null || span == null) return false;
  const needle = span.replace(SPACE, "");
  return needle !== "" && capture.toLowerCase().includes(needle.toLowerCase());
}

/** The span itself when verbatim; throws otherwise (a FACT is emitted only after this passes). */
export function assertVerbatim(capture: string | null | undefined, span: string | null | undefined): string {
  if (span == null || span.replace(SPACE, "") === "") throw new Error("verbatim: empty source_span");
  if (!isVerbatim(capture, span)) throw new Error(`verbatim: source_span is not a substring of the captured source text: ${JSON.stringify(span)}`);
  return span;
}

/** Ground a producer candidate against its capture; a missing span, a missing capture or a paraphrase is refused with its reason. */
export function groundCandidate(candidate: { span_text?: string | null } | null | undefined, captureText: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const span = candidate?.span_text;
  if (!span || !span.trim()) return { ok: false, reason: "no span_text supplied: a figure with no supporting span is ungrounded, refused per ADR-016 / rule 18" };
  if (!captureText || !captureText.trim()) return { ok: false, reason: "no capture text available for this candidate's source_url, cannot verify the span" };
  if (!isVerbatim(captureText, span)) return { ok: false, reason: "span_text is not a verbatim substring of the captured source text (database criterion-3 rule)" };
  return { ok: true };
}
