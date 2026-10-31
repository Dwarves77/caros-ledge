// Ported from old_repo/src/lib/connections/flag-namespaces.mjs (lines 1-96)
// Ported from old_repo/src/lib/connections/decision-note.mjs (lines 13-27)
// Ported from old_repo/src/lib/connections/coverage-reflection.mjs (lines 1-43)
// Ported from old_repo/scripts/connections/propose-tags.mjs (lines 101-198)
// Ported from old_repo/scripts/connections/analyze-corpus.mjs (lines 60-76)
// The flag grammar of the connection layer: one namespaced created_by per finding family, a subject_ref, dedup on (subject_ref, created_by)
// against open rows, and a finding is born OPEN and resolved by the pass that no longer makes it (ENGINE-JOIN-1): a gap that is still real stays visible, one that closed does not linger. Nothing waits on a person.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";

export const GAP_NAMESPACE = "flywheel-gap:";
export const ANTICIPATE_NAMESPACE = "flywheel-anticipate:";
export const TAG_NAMESPACE = "flywheel-tag:";
export const QUESTION_NAMESPACE = "question:";
export const HOLDINGS_NEED_NAMESPACE = "holdings-need:";
export const HOLDINGS_NEED_ACTION = "find-source";
export const TERM_NEED_NAMESPACE = "term-need:";
export const TERM_NEED_ACTION = HOLDINGS_NEED_ACTION;

export function createdBy(namespace: string, subtype: unknown): string {
  if (typeof namespace !== "string" || !namespace.endsWith(":")) throw new Error(`flag-namespaces.createdBy: namespace must end in ':' (got ${JSON.stringify(namespace)})`);
  const st = String(subtype ?? "").trim();
  if (!st) throw new Error("flag-namespaces.createdBy: subtype is required.");
  return `${namespace}${st}`;
}
export const buildSubjectRef = (...parts: unknown[]): string => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(":");

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
const key = (subjectRef: string, by: string): string => `${subjectRef}|${by}`;

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
  /** Open flags whose finding the pass no longer makes: resolved by it. */
  resolved: number;
  unchanged: number;
  failed: number;
  notes: string[];
}

/** The flags of a namespace in the given statuses (default: every status). A failed page throws. */
async function readFlagKeys(sb: Db, namespace: string, statuses?: readonly string[]): Promise<{ id: string; subject_ref: string; created_by: string; status: string }[]> {
  return fetchAllRows((from, to) => {
    let q = sb.from("integrity_flags").select("id, subject_ref, created_by, status").like("created_by", `${namespace}%`);
    if (statuses) q = q.in("status", [...statuses]);
    return q.order("id", { ascending: true }).range(from, to);
  }, { cap: 500_000 });
}

const OPEN = ["open", "in_review"];
const NO_LONGER_MADE = "the pass no longer makes this finding: the gap it named is closed or its subject is gone.";

/**
 * Reflect a pass's findings as OPEN flags: a finding with no open flag is inserted (born open), and an open flag of the namespace (limited to `owns`, the created_by values this pass is the writer of) whose finding the pass no longer makes is resolved by `resolvedBy`.
 * Errors are counted and noted, never swallowed; a dry run counts both and writes nothing.
 */
export async function reflectFindings(sb: Db, namespace: string, fresh: readonly Finding[], resolvedBy: string, nowIso: string, opts: { dry?: boolean; owns?: (createdBy: string) => boolean } = {}): Promise<FlagCounts> {
  const out: FlagCounts = { inserted: 0, resolved: 0, unchanged: 0, failed: 0, notes: [] };
  const open = (await readFlagKeys(sb, namespace, OPEN)).filter((f) => opts.owns?.(f.created_by) ?? true);
  const plan = planReflect(open, fresh.map((f) => ({ ...f, row: { ...f.row, status: "open" as const } })));
  out.unchanged = plan.unchanged;
  if (opts.dry) return { ...out, inserted: plan.newRows.length, resolved: plan.staleIds.length };
  for (let i = 0; i < plan.newRows.length; i += 200) {
    const batch = plan.newRows.slice(i, i + 200);
    const { error } = await sb.from("integrity_flags").insert(batch);
    if (error) {
      out.failed += batch.length;
      out.notes.push(`integrity_flags insert (${namespace}) chunk ${i} failed: ${error.message}`);
    } else out.inserted += batch.length;
  }
  for (let i = 0; i < plan.staleIds.length; i += 100) {
    const ids = plan.staleIds.slice(i, i + 100);
    const { error } = await sb.from("integrity_flags").update({ status: "resolved", resolved_at: nowIso, resolved_by: resolvedBy, resolution_note: NO_LONGER_MADE }).in("id", ids).in("status", OPEN);
    if (error) {
      out.failed += ids.length;
      out.notes.push(`integrity_flags resolve (${namespace}) chunk ${i} failed: ${error.message}`);
    } else out.resolved += ids.length;
  }
  return out;
}
