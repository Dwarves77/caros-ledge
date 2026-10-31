// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the connect stage's pattern step. Loads the joined input, runs the five detectors, and records each pattern as a derived value under its registered method (grade, admissibility, method version) with one derivation edge per evidence
// row (member, evidence or key), superseding the pattern it replaces when its value or evidence changed and retiring one no detector finds any more. A pattern whose inputs are only partly held is recorded too, as a FORMING row (lifecycle forming, method forming_<family>) that
// states in a reader's words what is missing (surface, truth, entity); it is superseded when the pattern appears and obsolete when its inputs vanish (ENGINE-JOIN-1 addendum B). Forming rows are invisible to every admissible read (migration 0145). The counts per kind are the stage's ledger counts; a dry run plans the same counts and writes nothing. Run after the corpus pass, every turn.
import { readAll, type Row } from "@/core/coupling/read";
import type { Db } from "@/core/db";
import { entityRefs, missingTruth } from "@/core/flywheel/facts-join";
import { createdBy, GAP_NAMESPACE, reflectFindings } from "@/core/flywheel/flags";
import { gapFindings, patternGaps } from "@/core/flywheel/gaps";
import { PATTERN_METHODS } from "@/core/propagation/methods";
import { registerDerivedValue } from "@/core/propagation/register";
import type { InputRef } from "@/core/propagation/types";
import type { RunResult } from "@/core/types/run-result";

import { PATTERNS } from "./config";
import { DETECTORS, meet } from "./detect";
import { gradeOf } from "./facts";
import { loadPatternInput } from "./load";
import { trackPatterns } from "./signposts";
import { KINDS, type Fact, type Pattern, type PatternInput, type PatternKind } from "./types";

const DEAD = ["falsified", "obsolete", "superseded"];
const tagOf = (p: Pattern): string => `${PATTERN_METHODS[p.kind].id}@${PATTERN_METHODS[p.kind].version}:${p.key}`;
const signature = (refs: readonly { table: string; pk: string; kind?: string }[]): string => refs.map((r) => `${r.table}/${r.pk}/${r.kind ?? "input"}`).sort().join();

/** The edges of a pattern, one per evidence row, each carrying the entities and surface the drain needs to recompute it. */
function inputsOf(p: Pick<Pattern, "evidence">, facts: ReadonlyMap<string, Fact>): InputRef[] {
  const seen = new Set<string>();
  return p.evidence.flatMap((e) => {
    const k = `${e.table}/${e.pk}/${e.kind}`;
    if (seen.has(k)) return [];
    seen.add(k);
    return [{ table: e.table, pk: e.pk, kind: e.kind, entities: e.entities, surface: facts.get(`${e.table}/${e.pk}`)?.surface ?? "unknown", ...(facts.get(`${e.table}/${e.pk}`)?.at ? { at: facts.get(`${e.table}/${e.pk}`)?.at as string } : {}), ...(e.relation ? { relation: e.relation } : {}), ...(e.summary ? { summary: e.summary } : {}), ...(e.role ? { role: e.role } : {}), ...(e.dueSource ? { dueSource: e.dueSource } : {}), ...(e.trl !== undefined ? { trl: e.trl } : {}), ...(e.onto ? { onto: e.onto } : {}), ...(e.marker ? { marker: e.marker } : {}), ...(facts.get(`${e.table}/${e.pk}`)?.duePrecision ? { due_precision: facts.get(`${e.table}/${e.pk}`)?.duePrecision as "month" | "year" } : {}) }];
  });
}

const NEEDS = createdBy(GAP_NAMESPACE, "pattern_");
/** The needs-search flags of the discovery hook (flywheel-gap kind, open): reflected through the one owner of the flag lifecycle (flags.ts): a need not yet raised is raised, a need this stage no longer raises is closed. A dry run counts both. */
async function raiseNeeds(sb: Db, gaps: ReturnType<typeof patternGaps>, dry: boolean, nowIso: string): Promise<{ counts: Record<string, number>; notes: string[] }> {
  const r = await reflectFindings(sb, GAP_NAMESPACE, gapFindings(gaps), "pattern-step", nowIso, { dry, owns: (by) => by.startsWith(NEEDS) });
  return { counts: { pattern_needs: gaps.length, pattern_needs_raised: dry ? 0 : r.inserted, pattern_needs_closed: dry ? 0 : r.resolved }, notes: r.notes };
}

/** A pattern started but missing a surface's truth: the family it would be, the row it stands on, the entity it is about and the surface that does not yet hold its other half. */
export interface Forming {
  kind: PatternKind;
  fact: Fact;
  entity: string;
  surface: string;
}
const FORMING_ID = (k: PatternKind): string => `forming_${PATTERN_METHODS[k].id.replace(/^pattern_/, "")}`;

/**
 * The patterns whose inputs are partly held (addendum B): a dated ratchet on an entity with no capacity figure meeting it (the Operations figure is missing), a statutory ceiling with no abatement cost meeting it (the Market figure when a technology is held, the
 * Research evaluation when none is), a pending trigger with no move meeting it (the Market move). A row already inside a found pattern of its family is not forming. Pure over the joined input; the entity is a specific one, else a jurisdiction.
 */
function formingOf(i: PatternInput, found: readonly Pattern[]): Forming[] {
  const today = i.now.toISOString().slice(0, 10);
  const cls = (e: string): string => i.classOf?.(e) ?? "";
  const entityOf = (f: Fact): string | undefined => [...f.entities].sort().find((e) => !PATTERNS.genericClasses.includes(cls(e))) ?? [...f.entities].sort().find((e) => cls(e) === "jurisdiction");
  const inside = (k: PatternKind, f: Fact): boolean => found.some((p) => p.kind === k && p.evidence.some((e) => e.table === f.table && e.pk === f.pk));
  const memo = new Map<string, Set<string>>();
  const met = (f: Fact, role: (r: string) => boolean): boolean => i.facts.some((o) => role(o.role) && meet(i, f.entities, o.entities, memo));
  const out = new Map<string, Forming>();
  const add = (kind: PatternKind, f: Fact, surface: string): void => {
    const entity = entityOf(f);
    const key = `${kind}|${f.item ?? f.pk}|${f.due ?? ""}|${entity}`;
    if (entity && !inside(kind, f) && !(out.get(key) && (out.get(key) as Forming).fact.pk < f.pk)) out.set(key, { kind, fact: f, entity, surface });
  };
  for (const r of i.facts.filter((f) => f.role === "ratchet" && f.due && f.due >= today)) if (!met(r, (x) => x === "capacity")) add("mandateCapacity", r, "operations");
  for (const k of i.facts.filter((f) => f.role === "ceiling" && f.qty !== null && f.qty > 0)) if (!met(k, (x) => x === "abatement")) add("penaltyAbatement", k, met(k, (x) => x === "tech") ? "market" : "research");
  for (const t of i.facts.filter((f) => f.role === "trigger" && !f.resolved && f.due && f.due >= today && PATTERNS.leadLag.triggerKinds.includes(f.kind ?? ""))) if (!met(t, (x) => ["series", "tech", "move", "capacity"].includes(x))) add("leadLag", t, "market");
  return [...out.values()].sort((a, b) => `${a.kind}|${a.fact.table}/${a.fact.pk}`.localeCompare(`${b.kind}|${b.fact.table}/${b.fact.pk}`));
}

/** The forming rows against the stored ones: new or changed ones registered (superseding the row they replace), one whose pattern has appeared superseded, one whose inputs vanished obsolete. A dry run counts the same. */
async function reconcileForming(sb: Db, forming: readonly Forming[], found: readonly Pattern[], facts: ReadonlyMap<string, Fact>, now: Date, dry: boolean): Promise<{ counts: Record<string, number>; notes: string[] }> {
  const counts: Record<string, number> = { forming: forming.length, forming_new: 0, forming_unchanged: 0, forming_superseded: 0, forming_emerged: 0, forming_obsolete: 0 };
  const notes: string[] = [];
  const held = (await readAll<Row>(sb, "derived_values", "value_id,method_id,computed_by,admissibility,lifecycle,inputs,missing", ["value_id"], (q) => q.in("method_id", KINDS.map(FORMING_ID)))).filter((r) => r.lifecycle === "forming");
  const current = new Map(held.map((r) => [String(r.computed_by), r]));
  const names = await entityRefs(sb, forming.map((f) => f.entity));
  const tagOfF = (f: Forming): string => `forming:${f.kind}|${f.fact.table}/${f.fact.pk}`;
  for (const f of forming) {
    const missing = { surface: f.surface, truth: missingTruth(f.surface, names.get(f.entity)?.canonicalName ?? null), entity: f.entity };
    const old = current.get(tagOfF(f));
    const refs = inputsOf({ evidence: [{ table: f.fact.table, pk: f.fact.pk, kind: "key", entities: f.fact.entities, role: f.fact.role }] }, facts);
    if (old && old.admissibility !== "stale" && JSON.stringify(old.missing) === JSON.stringify(missing) && signature(old.inputs as InputRef[]) === signature(refs)) {
      counts.forming_unchanged = (counts.forming_unchanged ?? 0) + 1;
      continue;
    }
    counts[old ? "forming_superseded" : "forming_new"] = (counts[old ? "forming_superseded" : "forming_new"] ?? 0) + 1;
    if (dry) continue;
    const id = await registerDerivedValue(sb, { entityId: f.entity, methodId: FORMING_ID(f.kind), methodVersion: PATTERN_METHODS[f.kind].version, derivation: "calculated", originClass: "derived", lifecycle: "forming", admissibility: "display_only", confidence: PATTERNS[f.kind].confidence, assertedAt: now.toISOString(), inputs: refs, computedBy: tagOfF(f), supersedes: old ? String(old.value_id) : null });
    const set = await sb.from("derived_values").update({ missing }).eq("value_id", id);
    if (set.error) notes.push(`forming ${id}: missing not stored: ${set.error.message}`);
    if (old) {
      const sup = await sb.from("derived_values").update({ lifecycle: "superseded" }).eq("value_id", old.value_id);
      if (sup.error) notes.push(`superseding forming ${String(old.value_id)} failed: ${sup.error.message}`);
    }
  }
  const fresh = new Set(forming.map(tagOfF));
  const gone = held.filter((r) => !fresh.has(String(r.computed_by)));
  const emerged = (r: Row): boolean => {
    const key = (r.inputs as InputRef[])[0];
    const kind = String(r.computed_by).slice("forming:".length).split("|")[0];
    return found.some((p) => p.kind === kind && p.evidence.some((e) => e.table === key?.table && e.pk === key?.pk));
  };
  for (const [ids, patch, label] of [[gone.filter(emerged), { lifecycle: "superseded" }, "forming_emerged"], [gone.filter((r) => !emerged(r)), { lifecycle: "obsolete", admissibility: "stale" }, "forming_obsolete"]] as const) {
    counts[label] = ids.length;
    if (dry || !ids.length) continue;
    const upd = await sb.from("derived_values").update(patch).in("value_id", ids.map((r) => String(r.value_id)));
    if (upd.error) notes.push(`${label}: ${ids.length} row(s) failed: ${upd.error.message}`);
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
  const formed = await reconcileForming(sb, formingOf(loaded.input, found), found, facts, now, input.dry);
  Object.assign(counts, formed.counts);
  notes.push(...formed.notes);
  // downstream, in the same run (rule 17): the signposts of the patterns found, and the needs-search rows a packet leaves open
  Object.assign(counts, await trackPatterns(deps, { dry: input.dry, found, facts }));
  const needs = await raiseNeeds(sb, patternGaps({ patterns: found, facts: loaded.input.facts, readerEdges: loaded.input.readerEdges ?? [], now, ...(loaded.input.classOf ? { classOf: loaded.input.classOf } : {}) }), input.dry, now.toISOString());
  Object.assign(counts, needs.counts);
  notes.push(...needs.notes);
  return { counts, outcome: notes.length ? "partial" : "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
}
