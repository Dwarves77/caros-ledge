// Ported from old_repo/src/lib/connections/flag-namespaces.mjs (lines 1-96)
// Ported from old_repo/src/lib/connections/decision-note.mjs (lines 13-27)
// Ported from old_repo/src/lib/connections/coverage-reflection.mjs (lines 1-43)
// Ported from old_repo/scripts/connections/propose-tags.mjs (lines 101-198)
// Ported from old_repo/scripts/connections/analyze-corpus.mjs (lines 60-76)
// The flag grammar of the connection layer: one namespaced created_by per finding family, a subject_ref, dedup on (subject_ref, created_by)
// against rows of ANY status, and a finding with nothing left to decide is written already resolved (ADR-030 rider). Nothing waits on a person.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";

export const GAP_NAMESPACE = "flywheel-gap:";
export const ANTICIPATE_NAMESPACE = "flywheel-anticipate:";
export const SIGNAL_NAMESPACE = "flywheel-signal:";
export const FLYWHEEL_DEFECT_NAMESPACE = "flywheel-defect:";
export const TAG_NAMESPACE = "flywheel-tag:";
export const QUESTION_NAMESPACE = "question:";
export const HOLDINGS_NEED_NAMESPACE = "holdings-need:";
export const HOLDINGS_NEED_ACTION = "find-source";
export const TERM_NEED_NAMESPACE = "term-need:";
export const TERM_NEED_ACTION = HOLDINGS_NEED_ACTION;
export const ALL_NAMESPACES: readonly string[] = [GAP_NAMESPACE, ANTICIPATE_NAMESPACE, SIGNAL_NAMESPACE, FLYWHEEL_DEFECT_NAMESPACE, TAG_NAMESPACE, QUESTION_NAMESPACE, HOLDINGS_NEED_NAMESPACE, TERM_NEED_NAMESPACE];

export function createdBy(namespace: string, subtype: unknown): string {
  if (typeof namespace !== "string" || !namespace.endsWith(":")) throw new Error(`flag-namespaces.createdBy: namespace must end in ':' (got ${JSON.stringify(namespace)})`);
  const st = String(subtype ?? "").trim();
  if (!st) throw new Error("flag-namespaces.createdBy: subtype is required.");
  return `${namespace}${st}`;
}
export const buildSubjectRef = (...parts: unknown[]): string => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(":");
export const isInNamespace = (value: unknown, namespace: string): boolean => typeof value === "string" && value.startsWith(namespace);

export interface Decision {
  label: string;
  decision: "adopt" | "decline";
  reason: string;
}
/** A resolution note: a summary line and the decisions as JSON, so the record of a rule-made decision is complete. */
export function buildDecisionNote(summaryPrefix: string, decisions: readonly Decision[]): string {
  const adopted = decisions.filter((d) => d.decision === "adopt").length;
  const declined = decisions.filter((d) => d.decision === "decline").length;
  return `${summaryPrefix}: decided ${decisions.length} (adopted ${adopted}, declined ${declined}).\n\nDECISIONS_JSON: ${JSON.stringify(decisions.map((d) => ({ label: d.label, decision: d.decision, reason: d.reason })))}`;
}

export interface FlagRow {
  category: string;
  subject_type: string;
  subject_ref: string;
  description: string;
  recommended_actions: unknown[];
  created_by: string;
  status?: "open" | "resolved";
  resolved_at?: string;
  resolved_by?: string;
  resolution_note?: string;
}
export interface Finding {
  subjectRef: string;
  row: FlagRow;
}
export const RESOLVED_REFLECTION_NOTE = "reflected in the coverage view; no per-row decision pending";

/** A finding as a row that was never open: the system records it and nothing waits on it. The clock is injected. */
export function buildResolvedRow(finding: FlagRow, resolvedBy: string, nowIso: string, note: string = RESOLVED_REFLECTION_NOTE): FlagRow {
  return { ...finding, status: "resolved", resolved_at: nowIso, resolved_by: resolvedBy, resolution_note: note };
}

const key = (subjectRef: string, by: string): string => `${subjectRef}|${by}`;

/** New rows are findings with no row of ANY status for the same (subject_ref, created_by); the rest are unchanged. */
export function planResolvedReflectionInserts(existingAnyStatus: readonly { subject_ref: string; created_by: string }[] | null | undefined, fresh: readonly Finding[] | null | undefined): { newRows: FlagRow[]; unchanged: number } {
  const existing = new Set((existingAnyStatus ?? []).map((r) => key(r.subject_ref, r.created_by)));
  const list = fresh ?? [];
  const newRows = list.filter((f) => !existing.has(key(f.subjectRef, f.row.created_by))).map((f) => f.row);
  return { newRows, unchanged: list.length - newRows.length };
}

/** Open flags against fresh findings: new rows for findings without one, and the open flags whose finding is no longer made (stale). */
export function planReflect(existingOpen: readonly { id: string; subject_ref: string; created_by: string }[] | null | undefined, fresh: readonly Finding[] | null | undefined, opts: { scopeSubjectRefs?: Set<string> | null } = {}): { newRows: FlagRow[]; staleIds: string[]; unchanged: number } {
  const existing = existingOpen ?? [];
  const freshList = fresh ?? [];
  const freshKeys = new Set(freshList.map((f) => key(f.subjectRef, f.row.created_by)));
  const existingKeys = new Set(existing.map((r) => key(r.subject_ref, r.created_by)));
  const newRows = freshList.filter((f) => !existingKeys.has(key(f.subjectRef, f.row.created_by))).map((f) => f.row);
  const scoped = opts.scopeSubjectRefs ? existing.filter((r) => opts.scopeSubjectRefs?.has(r.subject_ref)) : existing;
  return { newRows, staleIds: scoped.filter((r) => !freshKeys.has(key(r.subject_ref, r.created_by))).map((r) => r.id), unchanged: freshList.length - newRows.length };
}

export interface FlagCounts {
  inserted: number;
  unchanged: number;
  failed: number;
  notes: string[];
}

/** Every flag of a namespace, any status (the dedup key set). A failed page throws. */
export async function readFlagKeys(sb: Db, namespace: string, status?: "open"): Promise<{ id: string; subject_ref: string; created_by: string; status: string }[]> {
  return fetchAllRows((from, to) => {
    let q = sb.from("integrity_flags").select("id, subject_ref, created_by, status").like("created_by", `${namespace}%`);
    if (status) q = q.eq("status", status);
    return q.order("id", { ascending: true }).range(from, to);
  }, { cap: 500_000 });
}

/** Insert findings born resolved, de-duplicated against rows of any status. Errors are counted and noted, never swallowed. */
export async function reflectResolved(sb: Db, namespace: string, fresh: readonly Finding[], resolvedBy: string, nowIso: string, opts: { dry?: boolean } = {}): Promise<FlagCounts> {
  const out: FlagCounts = { inserted: 0, unchanged: 0, failed: 0, notes: [] };
  const existing = await readFlagKeys(sb, namespace);
  const resolved = fresh.map((f) => ({ subjectRef: f.subjectRef, row: buildResolvedRow(f.row, resolvedBy, nowIso) }));
  const { newRows, unchanged } = planResolvedReflectionInserts(existing, resolved);
  out.unchanged = unchanged;
  if (opts.dry || !newRows.length) return { ...out, inserted: opts.dry ? newRows.length : 0 };
  for (let i = 0; i < newRows.length; i += 200) {
    const batch = newRows.slice(i, i + 200);
    const { error } = await sb.from("integrity_flags").insert(batch);
    if (error) {
      out.failed += batch.length;
      out.notes.push(`integrity_flags insert (${namespace}) chunk ${i} failed: ${error.message}`);
    } else out.inserted += batch.length;
  }
  return out;
}
