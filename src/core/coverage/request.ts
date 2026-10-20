// Ported from old_repo/src/lib/coverage/request-coverage.mjs (lines 1-71)
import type { Db } from "@/core/db";

const COVERAGE_REQUEST_CREATED_BY = "coverage-request-route";
const COVERAGE_REQUEST_CATEGORY = "coverage_gap";
const COVERAGE_REQUEST_SUBJECT_TYPE = "surface";
const OPEN_STATUSES = ["open", "in_review"] as const;
const MAX_REF = 200;
const MAX_LABEL = 120;
// A path on this site: a leading slash, then path, query and fragment characters only. No scheme, no host, no dot segments, no protocol-relative start.
const SUBJECT_REF_RE = /^\/(?!\/)[A-Za-z0-9/_\-.?=&%#]*$/;

/** Validate the two strings a request may carry: a site path (never `//`, never `..`, at most 200 characters) and a label (control characters dropped, whitespace collapsed, at most 120). */
export function validateCoverageRequest(body: unknown): { ok: true; value: { subjectRef: string; label: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Send a JSON object with subjectRef and label." };
  const b = body as { subjectRef?: unknown; label?: unknown };
  const rawRef = typeof b.subjectRef === "string" ? b.subjectRef.trim() : "";
  if (!rawRef) return { ok: false, error: "subjectRef is required: the page path the gap is on." };
  if (rawRef.length > MAX_REF || !SUBJECT_REF_RE.test(rawRef) || rawRef.includes("..")) return { ok: false, error: "subjectRef must be a path on this site, for example /dashboard/coverage?data_class=research." };
  const label = (typeof b.label === "string" ? b.label : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!label) return { ok: false, error: "label is required: a few words naming what you are asking for." };
  if (label.length > MAX_LABEL) return { ok: false, error: `label must be ${MAX_LABEL} characters or fewer.` };
  return { ok: true, value: { subjectRef: rawRef, label } };
}
/** The integrity_flags row for a validated request; nothing from the caller is copied raw except the two validated strings. */
function buildCoverageGapFlag({ subjectRef, label }: { subjectRef: string; label: string }) {
  return {
    category: COVERAGE_REQUEST_CATEGORY,
    subject_type: COVERAGE_REQUEST_SUBJECT_TYPE,
    subject_ref: subjectRef,
    description: `Coverage requested for "${label}" at ${subjectRef}. Raised by a reader from the coverage surface of the product.`,
    recommended_actions: [{ action: "Check whether a source for this gap belongs in the registry, and register it through the source registry", rationale: "A reader asked for coverage here from the product itself, so the gap is one a customer noticed" }],
    status: "open",
    created_by: COVERAGE_REQUEST_CREATED_BY,
  };
}
/** Record one coverage request: at most one open flag per subject path (INV-163). The existence read and the insert both report their errors; a concurrent duplicate (23505) counts as already requested. */
export async function recordCoverageRequest(db: Db, input: { subjectRef: string; label: string }): Promise<{ ok: true; already: boolean } | { ok: false; error: string }> {
  const existing = await db.from("integrity_flags").select("id").eq("category", COVERAGE_REQUEST_CATEGORY).eq("subject_type", COVERAGE_REQUEST_SUBJECT_TYPE).eq("subject_ref", input.subjectRef).in("status", [...OPEN_STATUSES]).limit(1);
  if (existing.error) return { ok: false, error: "Could not check for an existing request." };
  if (Array.isArray(existing.data) && existing.data.length > 0) return { ok: true, already: true };
  const { error } = await db.from("integrity_flags").insert(buildCoverageGapFlag(input));
  if (error) return (error as { code?: string }).code === "23505" ? { ok: true, already: true } : { ok: false, error: "Could not record the request." };
  return { ok: true, already: false };
}
