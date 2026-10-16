// Ported from old_repo/src/lib/propagation/register-derivation.ts (lines 1-127)
// Ported from old_repo/src/lib/propagation/methods/infer-from-question.ts (lines 85-212)
// ONE validated, atomic register for the two derived tables: a derived value and its edges (register_derived_value), an inference record and its
// edges (register_inference_record). Both throw on any problem and never write partially. A first inference declares the items it cites as its
// inputs, so it has edges and can be recomputed when one of them is corrected or moves (B-0829; the allowlist admits items since migration 0010).
import type { Db } from "@/core/db";

import type { Admissibility, Derivation, InputRef, Lifecycle, OriginClass } from "./types";

export interface RegisterDerivedValueInput {
  entityId: string | null;
  methodId: string;
  methodVersion: string;
  value?: number | null;
  valueLow?: number | null;
  valueHigh?: number | null;
  unit?: string | null;
  currency?: string | null;
  derivation: Derivation;
  originClass: OriginClass;
  lifecycle: Lifecycle;
  admissibility: Admissibility;
  confidence: number;
  assertedAt: string | Date;
  halfLifeDays?: number | null;
  inputs: InputRef[];
  computedBy: string;
  supersedes?: string | null;
}

const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const unit = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function inputProblems(inputs: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(inputs)) return ["inputs must be an array"];
  const out: string[] = [];
  if (!allowEmpty && inputs.length === 0) out.push("inputs must name at least one input (a derivation with no edge can never be recomputed)");
  inputs.forEach((ref: InputRef, i: number) => {
    if (!ref || !text(ref.table)) out.push(`inputs[${i}].table must be a non-empty string`);
    if (!ref || !text(ref.pk)) out.push(`inputs[${i}].pk must be a non-empty string`);
  });
  return out;
}

/** Every problem with a derived-value registration; empty means valid. */
export function validateRegisterDerivedValueInput(input: RegisterDerivedValueInput): string[] {
  const problems: string[] = [];
  for (const f of ["methodId", "methodVersion", "derivation", "originClass", "lifecycle", "admissibility", "computedBy"] as const) {
    if (!text(input[f])) problems.push(`${f} must be a non-empty string`);
  }
  if (!unit(input.confidence)) problems.push(`confidence must be a finite number in [0, 1] (got ${JSON.stringify(input.confidence)})`);
  const asserted = input.assertedAt instanceof Date ? input.assertedAt.toISOString() : input.assertedAt;
  if (!asserted || Number.isNaN(Date.parse(asserted))) problems.push(`assertedAt must be a parseable date (got ${JSON.stringify(input.assertedAt)})`);
  if (input.halfLifeDays != null && (!Number.isFinite(input.halfLifeDays) || input.halfLifeDays <= 0)) problems.push(`halfLifeDays must be null/undefined or a positive finite number (got ${JSON.stringify(input.halfLifeDays)})`);
  problems.push(...inputProblems(input.inputs, true));
  return problems;
}

export async function registerDerivedValue(sb: Db, input: RegisterDerivedValueInput): Promise<string> {
  const problems = validateRegisterDerivedValueInput(input);
  if (problems.length) throw new Error(`registerDerivedValue: invalid input:\n  ${problems.join("\n  ")}`);
  const { data, error } = await sb.rpc("register_derived_value", {
    p_entity_id: input.entityId ?? null,
    p_method_id: input.methodId,
    p_method_version: input.methodVersion,
    p_value: input.value ?? null,
    p_value_low: input.valueLow ?? null,
    p_value_high: input.valueHigh ?? null,
    p_unit: input.unit ?? null,
    p_currency: input.currency ?? null,
    p_derivation: input.derivation,
    p_origin_class: input.originClass,
    p_lifecycle: input.lifecycle,
    p_admissibility: input.admissibility,
    p_base_confidence: input.confidence,
    p_asserted_at: input.assertedAt instanceof Date ? input.assertedAt.toISOString() : input.assertedAt,
    p_half_life_days: input.halfLifeDays ?? null,
    p_inputs: input.inputs,
    p_computed_by: input.computedBy,
    p_supersedes: input.supersedes ?? null,
  });
  if (error) throw new Error(`registerDerivedValue: register_derived_value RPC failed: ${error.message}`);
  return data as string;
}

export const STATUS_TOKENS = ["CONFIRMED", "HYPOTHESIS", "REFUTED"] as const;
export const INFERENCE_ORIGIN_CLASSES = ["derived", "modelled"] as const;
export type StatusToken = (typeof STATUS_TOKENS)[number];

export interface RegisterInferenceRecordInput {
  subjectId: string | null;
  claimText: string;
  statusToken: StatusToken;
  confidence: number;
  citedItemIds: string[];
  originClass: (typeof INFERENCE_ORIGIN_CLASSES)[number];
  methodId: string;
  methodVersion: string;
  computedBy: string;
  triggerQuestionRef?: string | null;
  inputs?: InputRef[];
  supersedes?: string | null;
}

export function validateRegisterInferenceRecordInput(input: RegisterInferenceRecordInput): string[] {
  const problems: string[] = [];
  if (!text(input.claimText)) problems.push("claimText must be a non-empty string");
  if (!STATUS_TOKENS.includes(input.statusToken)) problems.push(`statusToken must be one of ${STATUS_TOKENS.join(",")}`);
  if (!unit(input.confidence)) problems.push(`confidence must be a finite number in [0, 1] (got ${JSON.stringify(input.confidence)})`);
  if (!Array.isArray(input.citedItemIds) || input.citedItemIds.length === 0) problems.push("citedItemIds must be a non-empty array");
  if (!INFERENCE_ORIGIN_CLASSES.includes(input.originClass)) problems.push(`originClass must be one of ${INFERENCE_ORIGIN_CLASSES.join(",")}`);
  for (const f of ["methodId", "methodVersion", "computedBy"] as const) if (!text(input[f])) problems.push(`${f} must be a non-empty string`);
  problems.push(...inputProblems(input.inputs ?? [], true));
  return problems;
}

export async function registerInferenceRecord(sb: Db, input: RegisterInferenceRecordInput): Promise<string> {
  const problems = validateRegisterInferenceRecordInput(input);
  if (problems.length) throw new Error(`registerInferenceRecord: invalid input:\n  ${problems.join("\n  ")}`);
  const { data, error } = await sb.rpc("register_inference_record", {
    p_subject_id: input.subjectId ?? null,
    p_claim_text: input.claimText,
    p_status_token: input.statusToken,
    p_confidence: input.confidence,
    p_cited_item_ids: input.citedItemIds,
    p_origin_class: input.originClass,
    p_method_id: input.methodId,
    p_method_version: input.methodVersion,
    p_computed_by: input.computedBy,
    p_trigger_question_ref: input.triggerQuestionRef ?? null,
    p_inputs: input.inputs ?? [],
    p_supersedes: input.supersedes ?? null,
  });
  if (error) throw new Error(`registerInferenceRecord: register_inference_record RPC failed: ${error.message}`);
  return data as string;
}

export const INFER_METHOD_ID = "infer-from-question";
export const INFER_METHOD_VERSION = "v1";
export const firstInferenceComputedBy = (batch: string): string => `question-answers:${batch}`;

export interface FirstInferenceArgs {
  subjectId: string | null;
  claimText: string;
  statusToken: StatusToken;
  confidence: number;
  citedItemIds: string[];
  triggerQuestionRef: string;
  batch: string;
  supersedes?: string | null;
}

/** The registration of a first inference: a REFUTED claim is not an answer; the cited items are the declared inputs, so the row has edges. */
export function buildFirstInferenceInput(args: FirstInferenceArgs): RegisterInferenceRecordInput {
  if (args.statusToken === "REFUTED") throw new Error("buildFirstInferenceInput: a REFUTED inference is not an answer; refused");
  return {
    subjectId: args.subjectId ?? null, claimText: args.claimText, statusToken: args.statusToken, confidence: args.confidence, citedItemIds: args.citedItemIds, originClass: "derived",
    methodId: INFER_METHOD_ID, methodVersion: INFER_METHOD_VERSION, computedBy: firstInferenceComputedBy(args.batch), triggerQuestionRef: args.triggerQuestionRef,
    inputs: [...new Set(args.citedItemIds)].map((pk) => ({ table: "intelligence_items", pk })), supersedes: args.supersedes ?? null,
  };
}

export const registerFirstInference = (sb: Db, args: FirstInferenceArgs): Promise<string> => registerInferenceRecord(sb, buildFirstInferenceInput(args));
