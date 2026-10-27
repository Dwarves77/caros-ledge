// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the connect stage's pattern step. Loads the joined input, runs the five detectors, and records each pattern as a derived value under its registered method (grade, admissibility, method version) with one derivation edge per evidence
// row (member, evidence or key), superseding the pattern it replaces when its value or evidence changed and retiring one no detector finds any more. The counts per kind are the stage's ledger counts; a dry run plans the same counts and writes nothing. Run after the corpus pass, every turn.
import { readAll, type Row } from "@/core/coupling/read";
import type { Db } from "@/core/db";
import { allRows } from "@/core/db";
import { createdBy, GAP_NAMESPACE, planReflect } from "@/core/flywheel/flags";
import { gapFindings, patternGaps } from "@/core/flywheel/gaps";
import { PATTERN_METHODS } from "@/core/propagation/methods";
import { registerDerivedValue } from "@/core/propagation/register";
import type { InputRef } from "@/core/propagation/types";
import type { RunResult } from "@/core/types/run-result";

import { PATTERNS } from "./config";
import { DETECTORS } from "./detect";
import { gradeOf } from "./facts";
import { loadPatternInput } from "./load";
import { trackPatterns } from "./signposts";
import { KINDS, type Fact, type Pattern } from "./types";

const DEAD = ["falsified", "obsolete", "superseded"];
const tagOf = (p: Pattern): string => `${PATTERN_METHODS[p.kind].id}@${PATTERN_METHODS[p.kind].version}:${p.key}`;
const signature = (refs: readonly { table: string; pk: string; kind?: string }[]): string => refs.map((r) => `${r.table}/${r.pk}/${r.kind ?? "input"}`).sort().join();

/** The edges of a pattern, one per evidence row, each carrying the entities and surface the drain needs to recompute it. */
function inputsOf(p: Pattern, facts: ReadonlyMap<string, Fact>): InputRef[] {
  const seen = new Set<string>();
  return p.evidence.flatMap((e) => {
    const k = `${e.table}/${e.pk}/${e.kind}`;
    if (seen.has(k)) return [];
    seen.add(k);
    return [{ table: e.table, pk: e.pk, kind: e.kind, entities: e.entities, surface: facts.get(`${e.table}/${e.pk}`)?.surface ?? "unknown", ...(facts.get(`${e.table}/${e.pk}`)?.at ? { at: facts.get(`${e.table}/${e.pk}`)?.at as string } : {}), ...(e.relation ? { relation: e.relation } : {}), ...(e.summary ? { summary: e.summary } : {}), ...(facts.get(`${e.table}/${e.pk}`)?.duePrecision ? { due_precision: facts.get(`${e.table}/${e.pk}`)?.duePrecision as "month" | "year" } : {}) }];
  });
}

const PATTERN_NEED_OPEN = ["open", "in_review"];
const PATTERN_NEED_CLOSED = "pattern need closed by rule: the vertex it names is no longer missing, or the pattern or trigger that raised it is gone.";
/** The needs-search flags of the discovery hook (flywheel-gap kind, open): new needs are raised, a need the stage no longer raises is closed. A dry run counts both. */
async function raiseNeeds(sb: Db, gaps: ReturnType<typeof patternGaps>, dry: boolean, nowIso: string): Promise<{ counts: Record<string, number>; notes: string[] }> {
  const open = await allRows<{ id: string; subject_ref: string; created_by: string }>(sb, "integrity_flags", "id,subject_ref,created_by", { cap: 100_000, where: (q) => q.like("created_by", `${createdBy(GAP_NAMESPACE, "pattern_")}%`).in("status", PATTERN_NEED_OPEN) });
  const plan = planReflect(open, gapFindings(gaps).map((f) => ({ ...f, row: { ...f.row, status: "open" as const } })));
  const [counts, notes] = [{ pattern_needs: gaps.length, pattern_needs_raised: 0, pattern_needs_closed: 0 }, [] as string[]];
  if (dry) return { counts: { ...counts, pattern_needs_raised: 0 }, notes };
  if (plan.newRows.length) {
    const ins = await sb.from("integrity_flags").insert(plan.newRows);
    if (ins.error) notes.push(`pattern needs insert failed: ${ins.error.message}`);
    else counts.pattern_needs_raised = plan.newRows.length;
  }
  if (plan.staleIds.length) {
    const upd = await sb.from("integrity_flags").update({ status: "resolved", resolved_at: nowIso, resolved_by: "pattern-step", resolution_note: PATTERN_NEED_CLOSED }).in("id", plan.staleIds).in("status", PATTERN_NEED_OPEN);
    if (upd.error) notes.push(`pattern needs close failed: ${upd.error.message}`);
    else counts.pattern_needs_closed = plan.staleIds.length;
  }
  return { counts, notes };
}

export async function runPatterns(deps: { sb: Db; now: () => Date }, input: { dry: boolean }): Promise<RunResult> {
  const { sb } = deps;
  const now = deps.now();
  const loaded = await loadPatternInput(sb, now);
  const facts = new Map(loaded.input.facts.map((f) => [`${f.table}/${f.pk}`, f]));
  const found = KINDS.flatMap((k) => DETECTORS[k](loaded.input));
  const ids = KINDS.map((k) => PATTERN_METHODS[k].id);
  const held = (await readAll<Row>(sb, "derived_values", "value_id,method_id,method_version,computed_by,value,admissibility,lifecycle,inputs", ["value_id"], (q) => q.in("method_id", ids))).filter((r) => !DEAD.includes(String(r.lifecycle)));
  const current = new Map(held.map((r) => [String(r.computed_by), r]));
  const counts: Record<string, number> = { ...loaded.counts, patterns: found.length, patterns_new: 0, patterns_unchanged: 0, patterns_superseded: 0, patterns_obsolete: 0 };
  for (const k of KINDS) counts[`patterns_${k}`] = found.filter((p) => p.kind === k).length;
  const notes: string[] = [];
  const tags = new Set(found.map(tagOf));
  for (const p of found) {
    const old = current.get(tagOf(p));
    const refs = inputsOf(p, facts);
    const same = old && old.admissibility !== "stale" && Math.abs(Number(old.value) - p.value) < Number.EPSILON * Math.max(1, Math.abs(p.value)) * 8 && signature(old.inputs as InputRef[]) === signature(refs);
    if (same) {
      counts.patterns_unchanged = (counts.patterns_unchanged ?? 0) + 1;
      continue;
    }
    counts[old ? "patterns_superseded" : "patterns_new"] = (counts[old ? "patterns_superseded" : "patterns_new"] ?? 0) + 1;
    if (input.dry) continue;
    const m = PATTERN_METHODS[p.kind];
    const evidenceFacts = refs.map((r) => facts.get(`${r.table}/${r.pk}`)).filter((f): f is Fact => !!f);
    const valueId = await registerDerivedValue(sb, { entityId: p.entity, methodId: m.id, methodVersion: m.version, value: p.value, unit: p.unit, derivation: "calculated", originClass: "derived", lifecycle: "emerging", admissibility: gradeOf(evidenceFacts), confidence: PATTERNS[p.kind].confidence, assertedAt: now.toISOString(), inputs: refs, computedBy: tagOf(p), supersedes: old ? String(old.value_id) : null });
    if (old) {
      const sup = await sb.from("derived_values").update({ lifecycle: "superseded" }).eq("value_id", old.value_id);
      if (sup.error) notes.push(`superseding ${String(old.value_id)} by ${valueId} failed: ${sup.error.message}`);
    }
  }
  const gone = held.filter((r) => !tags.has(String(r.computed_by)));
  counts.patterns_obsolete = gone.length;
  if (!input.dry && gone.length) {
    const ret = await sb.from("derived_values").update({ lifecycle: "obsolete", admissibility: "stale" }).in("value_id", gone.map((r) => String(r.value_id)));
    if (ret.error) notes.push(`retiring ${gone.length} pattern(s) failed: ${ret.error.message}`);
  }
  // downstream, in the same run (rule 17): the signposts of the patterns found, and the needs-search rows a packet leaves open
  Object.assign(counts, await trackPatterns(deps, { dry: input.dry, found, facts }));
  const needs = await raiseNeeds(sb, patternGaps({ patterns: found, facts: loaded.input.facts, readerEdges: loaded.input.readerEdges ?? [], now }), input.dry, now.toISOString());
  Object.assign(counts, needs.counts);
  notes.push(...needs.notes);
  return { counts, outcome: notes.length ? "partial" : "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
}
