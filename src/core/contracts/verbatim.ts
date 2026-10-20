// Ported from old_repo/src/lib/contracts/verbatim-grounding.mjs (lines 14-31)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 14-25)
// The ONE verbatim rule, in JavaScript here and in SQL as public.is_verbatim (renderVerbatimSql below renders the function from the same constants; migration 0106 applies it and every database
// site that tested a span calls it). It mirrors validate_item_provenance criterion 3 exactly:
//   position(lower(btrim(source_span, ' ')) IN lower(result_content)) > 0
// btrim trims spaces only (U+0020), not tabs or newlines; a null capture or an empty span never matches. Producers, the healer, the quarantine resolver, the timeline and the obligation deriver call this
// and no second rule: a tolerant SEARCH may locate a candidate, and the candidate counts only when this verdict accepts it.

/** The characters the rule trims from a span (SQL btrim's second argument). */
const TRIM_CHARS = " ";
const TRIM = new RegExp(`^[${TRIM_CHARS}]+|[${TRIM_CHARS}]+$`, "g");

/** True when `span` is, after trimming spaces, a case-insensitive substring of `capture`. */
export function isVerbatim(capture: string | null | undefined, span: string | null | undefined): boolean {
  if (capture == null || span == null) return false;
  const needle = span.replace(TRIM, "");
  return needle !== "" && capture.toLowerCase().includes(needle.toLowerCase());
}

/** public.is_verbatim(p_capture, p_span): the rule above as a SQL function. GENERATED: migration 0106 carries this text and a test regenerates and diffs it. */
export function renderVerbatimSql(): string {
  return `CREATE OR REPLACE FUNCTION public.is_verbatim(p_capture text, p_span text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p_capture IS NOT NULL AND p_span IS NOT NULL AND btrim(p_span, '${TRIM_CHARS}') <> ''
     AND position(lower(btrim(p_span, '${TRIM_CHARS}')) IN lower(p_capture)) > 0
$$;`;
}

/** The span itself when verbatim; throws otherwise (a FACT is emitted only after this passes). */
export function assertVerbatim(capture: string | null | undefined, span: string | null | undefined): string {
  if (span == null || span.replace(TRIM, "") === "") throw new Error("verbatim: empty source_span");
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
