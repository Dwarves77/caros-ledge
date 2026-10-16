// Ported from old_repo/src/lib/propagation/author-edges.mjs (lines 1-146)
// Author the derived value and the edges of a landed figure (an emission factor, a market-series point) through its registered method, idempotent
// by (input, method). A producer calls this in the same run that wrote the figure (rule 17). Reads fail loudly; refusals are returned, not thrown.
import type { Db } from "@/core/db";

import { resolveInputs } from "./drain";
import { METHODS, type MethodRegistry } from "./methods";
import { registerDerivedValue } from "./register";
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

/** Whether any input already has a derived value by this method (so authoring twice is a no-op). A failed read throws. */
export async function hasBeenAuthored(sb: Db, inputs: readonly InputRef[], methodId: string, methodVersion: string): Promise<boolean> {
  for (const ref of inputs) {
    const edges = await sb.from("derivation_edges").select("to_value_id").eq("from_table", ref.table).eq("from_pk", String(ref.pk));
    if (edges.error) throw new Error(`author-edges: reading derivation_edges failed for ${ref.table}/${ref.pk}: ${edges.error.message}`);
    const valueIds = [...new Set(((edges.data ?? []) as { to_value_id: string | null }[]).map((e) => e.to_value_id).filter((v): v is string => !!v))];
    if (!valueIds.length) continue;
    const values = await sb.from("derived_values").select("value_id").in("value_id", valueIds).eq("method_id", methodId).eq("method_version", methodVersion).limit(1);
    if (values.error) throw new Error(`author-edges: reading derived_values failed for ${ref.table}/${ref.pk}: ${values.error.message}`);
    if ((values.data ?? []).length) return true;
  }
  return false;
}

export async function authorEdges(sb: Db, figure: Figure, deps: { now?: () => Date; registry?: MethodRegistry } = {}): Promise<AuthorResult> {
  const bad = (reason: string): AuthorResult => ({ ok: false, action: "invalid-input", reason });
  if (!figure?.table || typeof figure.table !== "string") return bad("figure.table must be a non-empty string");
  if (!figure.id) return bad("figure.id is required");
  if (!figure.method?.id || !figure.method.version) return bad("figure.method must be {id, version}, both non-empty strings");
  if (!Array.isArray(figure.inputs) || !figure.inputs.length) return bad("figure.inputs must be a non-empty InputRef[] array");
  for (const ref of figure.inputs) if (!ref || typeof ref.table !== "string" || !ref.table || ref.pk === undefined || ref.pk === null || ref.pk === "") return bad(`every input must be {table, pk}; got ${JSON.stringify(ref)}`);
  const fn = (deps.registry ?? METHODS).get("derived_values", figure.method.id, figure.method.version);
  if (!fn) return { ok: false, action: "unknown-method", reason: `no method registered for ${figure.method.id}@${figure.method.version}` };
  if (await hasBeenAuthored(sb, figure.inputs, figure.method.id, figure.method.version)) return { ok: true, action: "skipped-already-authored" };
  const now = (deps.now ?? (() => new Date()))();
  const entity = figure.entity ?? null;
  const result = await fn({ entityId: entity, inputs: await resolveInputs(sb, figure.inputs), priorValue: null, now });
  if (!result.ok) return { ok: false, action: "method-refused", reason: result.reason };
  const valueId = await registerDerivedValue(sb, {
    entityId: entity, methodId: figure.method.id, methodVersion: figure.method.version, value: result.value ?? null, valueLow: result.valueLow ?? null, valueHigh: result.valueHigh ?? null,
    unit: result.unit ?? null, currency: result.currency ?? null, derivation: result.derivation, originClass: result.originClass, lifecycle: result.lifecycle, admissibility: result.admissibility,
    confidence: result.confidence, assertedAt: now.toISOString(), halfLifeDays: result.halfLifeDays ?? null, inputs: figure.inputs, computedBy: `${figure.method.id}@${figure.method.version}:author-edges:${figure.table}:${figure.id}`,
  });
  return { ok: true, action: "authored", valueId };
}
