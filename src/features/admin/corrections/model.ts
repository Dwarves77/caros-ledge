// Ported from old_repo/src/components/admin/corrections/model.mjs (lines 1-196)
import { EDGE_RELATIONSHIPS, OPS_BY_KIND, TAG_COLUMNS, validateCorrectionInput } from "@/core/corrections/model";
import { requestJson, type JsonResult } from "@/core/http/request-json";

import type { CorrectionData, TargetKind } from "./types";

export { EDGE_RELATIONSHIPS, OPS_BY_KIND, TAG_COLUMNS };
export const KIND_FILTERS = ["fact", "tag", "connection", "section_text", "full_brief"] as const;
export const STATE_FILTERS = ["active", "revoked", "orphaned"] as const;
export type CorrectionState = (typeof STATE_FILTERS)[number];

const KIND_LABEL: Record<string, string> = { fact: "Fact", tag: "Tag", connection: "Connection", section_text: "Section text", full_brief: "Full brief" };
const STATE_LABEL: Record<string, string> = { active: "Active", revoked: "Revoked", orphaned: "Orphaned" };
const COLUMN_LABEL: Record<string, string> = { topic_tags: "Topic tags", operational_scenario_tags: "Scenario tags", compliance_object_tags: "Compliance object tags" };
const RELATIONSHIP_LABEL: Record<string, string> = { related: "Related to", supersedes: "Supersedes", implements: "Implements", conflicts: "Conflicts with", amends: "Amends", depends_on: "Depends on" };
export const kindLabel = (k: string): string => KIND_LABEL[k] ?? "Correction";
export const stateLabel = (s: string): string => STATE_LABEL[s] ?? "Active";
export const columnLabel = (c: string): string => COLUMN_LABEL[c] ?? "Tags";
export const relationshipLabel = (r: string): string => RELATIONSHIP_LABEL[r] ?? "Related to";

/** A plain sentence for what a correction does. No internal slugs. */
export function describeCorrection(c: Pick<CorrectionData, "target_kind" | "op" | "target_ref">): string {
  if (c.target_kind === "fact") return c.op === "suppress" ? "Hid a fact from customers" : "Replaced a fact";
  if (c.target_kind === "tag") {
    const tag = String(c.target_ref ?? "").split(":").slice(1).join(":");
    return c.op === "add" ? `Added the tag ${tag}` : `Removed the tag ${tag}`;
  }
  if (c.target_kind === "connection") return c.op === "add" ? "Added a connection to another item" : "Removed a connection to another item";
  if (c.target_kind === "section_text") return "Replaced the text of a section";
  if (c.target_kind === "full_brief") return "Replaced the full brief";
  return "Corrected item data";
}

/** active, revoked or orphaned. An orphaned correction is an ACTIVE fact correction matching no current claim. Pure. */
export function stateOf(c: Pick<CorrectionData, "active" | "revoked_at" | "orphaned"> | null | undefined): CorrectionState {
  if (!c || c.active === false || (c.revoked_at !== null && c.revoked_at !== undefined)) return "revoked";
  return c.orphaned === true ? "orphaned" : "active";
}

export const ORPHAN_EXPLANATION = "The fact this correction was made on has changed or been removed since, so it no longer matches anything on the item. Revoke it, then correct the current fact if it still needs fixing.";

/** Filter by state and target kind; an empty filter means all. */
export const filterCorrections = (rows: readonly CorrectionData[], f: { state?: string; kind?: string } = {}): CorrectionData[] => rows.filter((c) => (!f.state || stateOf(c) === f.state) && (!f.kind || c.target_kind === f.kind));
export function countByState(rows: readonly CorrectionData[]): Record<CorrectionState, number> {
  const out: Record<CorrectionState, number> = { active: 0, revoked: 0, orphaned: 0 };
  for (const c of rows) out[stateOf(c)] += 1;
  return out;
}
export const newestFirst = (rows: readonly CorrectionData[]): CorrectionData[] => [...rows].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));

/** The newest active, non-superseded correction for one target, or null. */
export function activeFor(corrections: readonly CorrectionData[], kind: string, ref: string): CorrectionData | null {
  const hits = newestFirst(corrections).filter((c) => c.target_kind === kind && c.target_ref === ref && stateOf(c) !== "revoked");
  return hits.find((c) => c.superseded !== true) ?? hits[0] ?? null;
}
/** The machine value a correction overrode: what a writer last tried to store, else what was captured. */
export const machineValueOf = (c: Pick<CorrectionData, "latest_machine_value" | "machine_value"> | null | undefined): Record<string, unknown> | null => c?.latest_machine_value ?? c?.machine_value ?? null;

const friendly = (v: { code: string; error: string }): string => (v.code === "reason_required" ? "Say why you are overriding the machine value. A reason is required." : v.code === "fact_needs_span" ? "A replacement fact needs a source span and the capture id it came from." : v.error);

export interface Draft {
  kind: TargetKind;
  op: string;
  ref: string;
  value?: Record<string, unknown> | null;
  reason: string;
}
/** The POST body for one action, checked with the API's own validator so a missing reason never leaves the browser. Pure. */
export function buildCorrectionBody(d: Draft): { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const body: Record<string, unknown> = { target_kind: d.kind, target_ref: d.ref, op: d.op, reason: d.reason, ...(d.value ? { value: d.value } : {}) };
  const v = validateCorrectionInput(body);
  return v.ok ? { ok: true, body: { ...body, reason: v.input.reason, target_ref: v.input.target_ref } } : { ok: false, code: v.code, message: friendly(v) };
}

/** The value object for each action's form fields. Pure; trims where the API trims. */
export function valueFor(kind: string, op: string, f: Record<string, string | undefined> = {}): Record<string, unknown> | null {
  if (kind === "full_brief" && op === "replace") return { text: String(f.text ?? "") };
  if (kind === "section_text" && op === "replace") return { content_md: String(f.content_md ?? "") };
  if (kind === "fact" && op === "replace") return { source_span: String(f.source_span ?? "").trim(), search_result_id: String(f.search_result_id ?? "").trim(), ...(String(f.claim_text ?? "").trim() ? { claim_text: String(f.claim_text).trim() } : {}) };
  if (kind === "connection" && op === "add") return f.relationship ? { relationship: f.relationship } : null;
  return null;
}

export type Call = <T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown }) => Promise<JsonResult<T>>;
export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; status: number; code: string; message: string };
const base = (itemId: string) => `/api/admin/items/${encodeURIComponent(itemId)}/corrections`;
const fail = (r: JsonResult<unknown>): Outcome<never> => ({ ok: false, status: r.status, code: (r.data as { code?: string } | null)?.code ?? "", message: r.error ?? `The request failed (status ${r.status}).` });

/** GET the item's corrections. */
export async function fetchItemCorrections(itemId: string, call: Call = requestJson): Promise<Outcome<{ corrections: CorrectionData[] }>> {
  const r = await call<{ corrections?: CorrectionData[] }>(base(itemId));
  return r.ok ? { ok: true, corrections: r.data?.corrections ?? [] } : fail(r);
}
/** POST one correction. Validated first. */
export async function postCorrection(itemId: string, draft: Draft, call: Call = requestJson): Promise<Outcome<{ id: string | null }>> {
  const built = buildCorrectionBody(draft);
  if (!built.ok) return { ok: false, status: 0, code: built.code, message: built.message };
  const r = await call<{ id?: string }>(base(itemId), { method: "POST", body: built.body });
  return r.ok ? { ok: true, id: r.data?.id ?? null } : fail(r);
}
/** POST a revoke. A reason is required on this screen even though the API treats it as optional. */
export async function postRevoke(itemId: string, correctionId: string, reason: string, call: Call = requestJson): Promise<Outcome> {
  const text = reason.trim();
  if (!text) return { ok: false, status: 0, code: "reason_required", message: "Say why you are revoking this correction. A reason is required." };
  const r = await call(`${base(itemId)}/${encodeURIComponent(correctionId)}/revoke`, { method: "POST", body: { reason: text } });
  return r.ok ? { ok: true } : fail(r);
}
