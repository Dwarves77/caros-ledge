// Ported from old_repo/src/lib/propagation/author-edges.mjs (lines 1-146)
// Author the derived value and the edges of a landed figure (an emission factor, a market-series point) through its registered method, once per
// (method, version, input): the existence check and the write are ONE statement (author_derived_value, migration 0091), so two workers author one value. A producer calls this in the same run that
// wrote the figure (rule 17). The clock is the caller's (`deps.now`). Reads fail loudly; refusals are returned, not thrown.
import type { Db } from "@/core/db";

import { resolveInputs } from "./drain";
import { METHODS, type MethodRegistry } from "./methods";
import { authorDerivedValue } from "./register";
import type { InputRef } from "./types";

export interface Figure {
  table: string;
  id: string;
  entity?: string | null;
  method: { id: string; version: string };
  inputs: InputRef[];
}
export type AuthorResult =
  | { ok: true; action: "authored"; valueId: string }
  | { ok: true; action: "skipped-already-authored" }
  | { ok: false; action: "invalid-input" | "unknown-method" | "method-refused"; reason: string };

export async function authorEdges(sb: Db, figure: Figure, deps: { now: () => Date; registry?: MethodRegistry }): Promise<AuthorResult> {
  const bad = (reason: string): AuthorResult => ({ ok: false, action: "invalid-input", reason });
  if (!figure?.table || typeof figure.table !== "string") return bad("figure.table must be a non-empty string");
  if (!figure.id) return bad("figure.id is required");
  if (!figure.method?.id || !figure.method.version) return bad("figure.method must be {id, version}, both non-empty strings");
  if (!Array.isArray(figure.inputs) || !figure.inputs.length) return bad("figure.inputs must be a non-empty InputRef[] array");
  for (const ref of figure.inputs) if (!ref || typeof ref.table !== "string" || !ref.table || ref.pk === undefined || ref.pk === null || ref.pk === "") return bad(`every input must be {table, pk}; got ${JSON.stringify(ref)}`);
  if (typeof deps?.now !== "function") return bad("deps.now is required: the clock is the caller's");
  const fn = (deps.registry ?? METHODS).get("derived_values", figure.method.id, figure.method.version);
  if (!fn) return { ok: false, action: "unknown-method", reason: `no method registered for ${figure.method.id}@${figure.method.version}` };
  const now = deps.now();
  const entity = figure.entity ?? null;
  const result = await fn({ entityId: entity, inputs: await resolveInputs(sb, figure.inputs), priorValue: null, now });
  if (!result.ok) return { ok: false, action: "method-refused", reason: result.reason };
  const { valueId, authored } = await authorDerivedValue(sb, {
    entityId: entity, methodId: figure.method.id, methodVersion: figure.method.version, value: result.value ?? null, valueLow: result.valueLow ?? null, valueHigh: result.valueHigh ?? null,
    unit: result.unit ?? null, currency: result.currency ?? null, derivation: result.derivation, originClass: result.originClass, lifecycle: result.lifecycle, admissibility: result.admissibility,
    confidence: result.confidence, assertedAt: now.toISOString(), halfLifeDays: result.halfLifeDays ?? null, inputs: figure.inputs, computedBy: `${figure.method.id}@${figure.method.version}:author-edges:${figure.table}:${figure.id}`,
  });
  return authored ? { ok: true, action: "authored", valueId } : { ok: true, action: "skipped-already-authored" };
}
