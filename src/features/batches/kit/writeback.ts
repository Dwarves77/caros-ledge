// New in ENGINE-UNBLOCK-1 lane C (scripts/ci/new-files/engine-unblock-1c.txt), operator engine spec 2026-10-26 (the 5-stage loop): the write-back every analysis kind shares. A reader that analyses may also emit signposts (the future evidence that confirms or
// falsifies), coverage gaps (what the next turn must search for) and new connections between entities. ONE module verifies and writes all three, so admin-opportunity-findings and theme-briefs import it and item-briefs can adopt it next. Verification: a
// signpost names an observable, a closed source class, what confirms and what falsifies it, and a future date; a coverage gap names the missing input and a closed source class; a connection goes through the item-briefs emission validator (entity ids that
// exist, a relation of couplings.json, a quote verbatim in a capture the entry may quote). A refusal names the element; nothing is dropped silently. Writes: signposts are inference records (the existing registration), connections are entity_relations through
// the item-briefs emission writer (imported, not copied), and a coverage gap is QUEUED as a holdings-need flag that the needs-search export reads as a find-source need (HUNT, stage 5): deduplicated, never fetched (CLAUDE.md rule 16).
import { createHash } from "node:crypto";

import { locateSpan } from "@/core/contracts/verbatim";
import { rowsByIds, type Db } from "@/core/db";
import { findFigures, isFigure, stateFigure } from "@/core/parse";
import { createdBy, HOLDINGS_NEED_ACTION, HOLDINGS_NEED_NAMESPACE } from "@/core/flywheel/flags";
import { registerInferenceRecord, type InputRef } from "@/core/propagation";
import type { RegisterInferenceRecordInput } from "@/core/propagation/register";

import { validateEmission, type EmissionPlan } from "../kinds/item-briefs/emission";
import { writeEmission } from "../kinds/item-briefs/emit";

import { isObj, nonEmpty, type BatchDeps, type Locate, type Obj } from "./session-batch";

/** The institution classes of the host class table (core/sources/data/host-class.json keys) a source may be sought in; a test keeps this list equal to the table's keys. */
export const SOURCE_CLASSES = ["legalPrimary", "legalPublisherAllow", "govIntergov", "intergovAnalysis", "verifierCab", "academicTld", "associationAllow", "standardsBodyAllow", "lawfirm", "news", "analysis", "big4Advisory"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
/** The tables a derivation edge admits (migration 0134, derivation_edges_from_table_allowed); a test keeps this list equal to the migration's. */
export const EDGE_TABLES = ["emission_factors", "market_series", "regional_data_facts", "derived_values", "statutory_computations", "estimated_values", "state_cost_facts", "inference_records", "intelligence_items", "section_claim_provenance", "obligation_objects", "oem_tech_roadmaps", "grid_connection_queues", "reroute_events", "research_assessments", "indexation_clauses", "item_forward_events"] as const;
/** The column that names the intelligence item a row of an evidence table belongs to (a signpost cites items). */
const ITEM_COLUMN: Readonly<Record<string, string>> = { intelligence_items: "id", section_claim_provenance: "intelligence_item_id", item_forward_events: "intelligence_item_id", obligation_objects: "instrument_item_id" };
/** The column that holds the primary key of a table whose key is not `id`. */
const PK_COLUMN: Readonly<Record<string, string>> = { obligation_objects: "obligation_id" };
/** The created_by of a queued coverage gap: a holdings-need target the needs-search export reads as a find-source need. */
export const GAP_CREATED_BY = createdBy(HOLDINGS_NEED_NAMESPACE, "synthesis-gap");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const isSourceClass = (v: unknown): v is SourceClass => (SOURCE_CLASSES as readonly unknown[]).includes(v);

export interface SignpostPlan { claim_text: string; observable: string; source_class: SourceClass; confirms_if: string; falsified_if: string; by: string }
export interface GapPlan { missing_input: string; source_class: SourceClass; key: string }
export interface WritebackPlan { signposts: SignpostPlan[]; gaps: GapPlan[]; connections: EmissionPlan["connections"] }
/** What a kind supplies about the material an entry may quote: its captures, the entity ids that exist (to their canonical id), the clock and the intelligence items its rows belong to. */
export interface WritebackLive { /** the grounded text of the rows and captures the entry cites: a gap may not claim a figure missing that this text states */ evidence?: readonly string[]; captures: ReadonlyMap<string, string>; ids: ReadonlyMap<string, string>; now: Date; locate?: Locate | null | undefined; itemIds: readonly string[] }

/** The identity of a coverage gap across clusters, themes and batches: the class and the missing input, whitespace and case collapsed. */
const gapKey = (g: { source_class: string; missing_input: string }): string => createHash("sha256").update(`${g.source_class}\u0000${norm(g.missing_input)}`).digest("hex").slice(0, 16);

/** The signposts, coverage gaps and connections of one entry against the live material: the plan, or the errors each naming its element. An entry that carries none of the three yields the empty plan. */
export function verifyWriteback(entry: Obj, tag: string, live: WritebackLive): { errors: string[]; plan: WritebackPlan } {
  const errors: string[] = [];
  const err = (at: string, m: string): void => void errors.push(`${tag} ${at}: ${m}`);
  const list = (b: string): unknown[] => (entry[b] === undefined ? [] : Array.isArray(entry[b]) ? (entry[b] as unknown[]) : (err(b, "must be an array"), []));
  const signposts: SignpostPlan[] = [];
  list("signposts").forEach((s, k) => {
    const at = `signposts[${k}]`;
    if (!isObj(s) || !nonEmpty(s.claim_text) || !nonEmpty(s.observable) || !nonEmpty(s.confirms_if) || !nonEmpty(s.falsified_if)) return err(at, "must be { claim_text, observable, source_class, confirms_if, falsified_if, by }: an observable future data point and what confirms and what falsifies it");
    if (!isSourceClass(s.source_class)) return err(at, `source_class ${JSON.stringify(s.source_class)} is not an institution class (${SOURCE_CLASSES.join(", ")})`);
    if (typeof s.by !== "string" || !ISO.test(s.by) || Number.isNaN(Date.parse(s.by))) return err(at, "by must be an ISO date (YYYY-MM-DD)");
    if (Date.parse(s.by) <= live.now.getTime()) return err(at, `by ${s.by} is not in the future: a signpost is evidence that has not yet arrived`);
    if (!live.itemIds.length) return err(at, "a signpost cites at least one intelligence item, and the rows this entry cites name none");
    signposts.push({ claim_text: s.claim_text.trim(), observable: s.observable.trim(), source_class: s.source_class, confirms_if: s.confirms_if.trim(), falsified_if: s.falsified_if.trim(), by: s.by });
  });
  const gaps: GapPlan[] = [];
  list("coverage_gaps").forEach((g, k) => {
    const at = `coverage_gaps[${k}]`;
    if (!isObj(g) || !nonEmpty(g.missing_input) || g.missing_input.length > 400) return err(at, "must be { missing_input (1 to 400 characters), source_class }");
    if (!isSourceClass(g.source_class)) return err(at, `source_class ${JSON.stringify(g.source_class)} is not an institution class (${SOURCE_CLASSES.join(", ")})`);
    // CONTAIN-FIX-1: a gap does not deny a figure with its unit that the cited evidence states (the one typed comparator, core/parse stateFigure)
    const held = live.evidence?.length ? findFigures(g.missing_input).flatMap((h) => (isFigure(h.result) && h.result.unit && stateFigure(live.evidence!.join(" "), h.result) ? [h.result.literal] : [])) : [];
    if (held.length) return err(at, `asks for ${JSON.stringify(g.missing_input.slice(0, 120))}, but its figure ${held.join(", ")} is already stated in a cited row or capture`);
    const gap = { missing_input: g.missing_input.trim(), source_class: g.source_class, key: "" };
    gap.key = gapKey(gap);
    if (gaps.some((x) => x.key === gap.key)) return err(at, "repeats an earlier coverage gap of this entry");
    gaps.push(gap);
  });
  const connections: EmissionPlan["connections"] = [];
  if (entry.connections !== undefined) {
    const v = validateEmission({ connections: entry.connections } as Obj, tag, { captures: live.captures, ids: live.ids, objects: new Map(), locate: live.locate ?? locateSpan });
    errors.push(...v.errors);
    connections.push(...(v.plan?.connections ?? []));
  }
  return { errors, plan: { signposts, gaps, connections } };
}

/** The entity ids an entry's connections name, for the caller's existence read. */
export const connectionEntityIds = (entry: Obj): string[] => (Array.isArray(entry.connections) ? entry.connections : []).flatMap((c) => (isObj(c) ? [c.from_entity_id, c.to_entity_id] : [])).filter((x): x is string => typeof x === "string");

/** The ids that exist and are active in `entities`, each to itself (a merged entity is not writable: the reader names its successor). */
export async function activeEntityIds(sb: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const found = await rowsByIds<{ entity_id: string; status: string }>(sb, "entities", "entity_id, status", [...new Set(ids)], "entity_id", "entity_id");
  return new Map(found.filter((e) => e.status === "active").map((e) => [e.entity_id, e.entity_id]));
}

/** The intelligence item ids the cited rows belong to (a row of a table that names no item contributes none). */
export async function itemIdsOfRows(sb: Db, rows: readonly { table: string; pk: string }[]): Promise<string[]> {
  const out = new Set<string>();
  for (const table of new Set(rows.map((r) => r.table))) {
    const col = ITEM_COLUMN[table];
    if (!col) continue;
    const pks = rows.filter((r) => r.table === table).map((r) => r.pk);
    if (table === "intelligence_items") pks.forEach((p) => out.add(p));
    else { const key = PK_COLUMN[table] ?? "id"; for (const r of await rowsByIds<Record<string, string>>(sb, table, `${key}, ${col}`, pks, key, key)) if (r[col]) out.add(r[col]); }
  }
  return [...out];
}

/** The text a signpost is registered under (the one place it is composed, so a re-apply finds what an earlier one wrote). */
const signpostClaim = (s: SignpostPlan): string => `${s.claim_text} (observe: ${s.observable}; source class: ${s.source_class}; confirmed if: ${s.confirms_if}; falsified if: ${s.falsified_if}; by ${s.by})`;
/** The inference records of a method already holding these claims, claim to id. */
async function heldInferences(sb: Db, methodId: string, claims: readonly string[]): Promise<Map<string, string>> {
  const rows = await rowsByIds<{ inference_id: string; claim_text: string; method_id: string }>(sb, "inference_records", "inference_id, claim_text, method_id", [...new Set(claims)], "claim_text", "inference_id");
  return new Map(rows.filter((r) => r.method_id === methodId).map((r) => [r.claim_text, r.inference_id]));
}
/** Register an inference record once per (method, claim text): a re-apply reuses the record an earlier apply wrote. */
export async function registerOnce(sb: Db, input: RegisterInferenceRecordInput): Promise<string> {
  return (await heldInferences(sb, input.methodId, [input.claimText])).get(input.claimText) ?? registerInferenceRecord(sb, input);
}

/** What an earlier apply already wrote of the entries' write-back: signposts (claim to id), queued gaps (their subject refs) and connections (parent|child|relation), so a re-apply of the same entry is "already applied". */
export interface HeldWriteback { signposts: ReadonlyMap<string, string>; gaps: ReadonlySet<string>; relations: ReadonlySet<string> }
const trimmed = (x: Obj): Obj => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
export async function heldWriteback(sb: Db, kind: string, entries: readonly Obj[]): Promise<HeldWriteback> {
  const arr = (e: Obj, k: string): Obj[] => (Array.isArray(e[k]) ? (e[k] as unknown[]).filter(isObj) : []);
  const claims = entries.flatMap((e) => arr(e, "signposts").flatMap((x) => (["claim_text", "observable", "source_class", "confirms_if", "falsified_if", "by"].every((k) => typeof x[k] === "string") ? [signpostClaim(trimmed(x) as never)] : [])));
  const gapRefs = entries.flatMap((e) => arr(e, "coverage_gaps").flatMap((g) => (typeof g.missing_input === "string" && typeof g.source_class === "string" ? [`gap:${gapKey(trimmed(g) as never)}`] : [])));
  const ents = entries.flatMap(connectionEntityIds);
  const [signposts, flags, rels] = [
    claims.length ? await heldInferences(sb, `${kind}-signpost`, claims) : new Map<string, string>(),
    gapRefs.length ? await rowsByIds<{ id: string; subject_ref: string; created_by: string }>(sb, "integrity_flags", "id, subject_ref, created_by", gapRefs, "subject_ref", "id") : [],
    ents.length ? await rowsByIds<{ parent_entity_id: string; child_entity_id: string; relation: string }>(sb, "entity_relations", "parent_entity_id, child_entity_id, relation", [...new Set(ents)], "parent_entity_id", "parent_entity_id") : [],
  ];
  return { signposts, gaps: new Set(flags.filter((f) => f.created_by === GAP_CREATED_BY).map((f) => f.subject_ref)), relations: new Set(rels.map((r) => `${r.parent_entity_id}|${r.child_entity_id}|${r.relation}`)) };
}
/** Whether every element of the plan is already written. */
export const writebackHeld = (plan: WritebackPlan, held: HeldWriteback): boolean =>
  plan.signposts.every((s) => held.signposts.has(signpostClaim(s))) && plan.gaps.every((g) => held.gaps.has(`gap:${g.key}`)) && plan.connections.every((c) => held.relations.has(`${c.parent}|${c.child}|${c.relation}`));

export interface WritebackCtx { kind: string; batch: string; /** the cluster or theme the entry analysed */ subject: string; /** the finding the gaps were raised by, when one was written */ findingId: string | null; citedItemIds: readonly string[]; inputs: readonly InputRef[] }

/** The gap's flag: a holdings-need target the needs-search export reads as a find-source need. One row per gap key, any status; a gap already queued gains this raiser, never a second row. Nothing here fetches. */
async function queueGaps(deps: BatchDeps, gaps: readonly GapPlan[], ctx: WritebackCtx, notes: string[]): Promise<{ queued: number; deduplicated: number }> {
  const by = GAP_CREATED_BY;
  const nowIso = deps.now().toISOString();
  const held = (await rowsByIds<{ id: string; subject_ref: string; created_by: string; status: string; recommended_actions: unknown }>(deps.sb, "integrity_flags", "id, subject_ref, created_by, status, recommended_actions", gaps.map((g) => `gap:${g.key}`), "subject_ref", "id")).filter((f) => f.created_by === by);
  const raiser = { raised_by: ctx.kind, subject: ctx.subject, finding_id: ctx.findingId, batch: ctx.batch };
  let [queued, deduplicated] = [0, 0];
  for (const g of gaps) {
    const prior = held.find((f) => f.subject_ref === `gap:${g.key}`);
    if (prior) {
      deduplicated += 1;
      const actions = Array.isArray(prior.recommended_actions) ? (prior.recommended_actions as Obj[]) : [];
      if (!actions.some((a) => a.action === "raised-again" && a.subject === ctx.subject && a.batch === ctx.batch)) {
        const { error } = await deps.sb.from("integrity_flags").update({ recommended_actions: [...actions, { action: "raised-again", ...raiser, recorded_at: nowIso }] }).eq("id", prior.id);
        if (error) notes.push(`coverage gap ${g.key}: the second raiser was not recorded: ${error.message}`);
      }
      continue;
    }
    const need = { action: HOLDINGS_NEED_ACTION, need: g.missing_input, kind: g.source_class, source_class: g.source_class, ...raiser, recorded_at: nowIso, rationale: `a ${ctx.kind} reading of ${ctx.subject} could not be completed without this input; a source of the class ${g.source_class} stating it is wanted` };
    const { error } = await deps.sb.from("integrity_flags").insert({ category: "coverage_gap", subject_type: "system", subject_ref: `gap:${g.key}`, status: "open", created_by: by, description: `Coverage gap: ${g.missing_input}`.slice(0, 480), recommended_actions: [need] });
    if (error) throw new Error(`coverage gap ${g.key} was not queued: ${error.message}`);
    queued += 1;
  }
  return { queued, deduplicated };
}

/** The writes of one entry's plan: signposts as inference records (their ids returned), connections through the emission writer, coverage gaps queued for the hunt. A refused connection is a note and a count; a failed signpost or gap throws. */
export async function writeWriteback(deps: BatchDeps, plan: WritebackPlan, ctx: WritebackCtx): Promise<{ signpostIds: string[]; counts: Record<string, number>; notes: string[] }> {
  const [counts, notes]: [Record<string, number>, string[]] = [{}, []];
  const signpostIds: string[] = [];
  for (const s of plan.signposts) {
    signpostIds.push(await registerOnce(deps.sb, { subjectId: null, claimText: signpostClaim(s), statusToken: "HYPOTHESIS", confidence: 0.5, citedItemIds: [...ctx.citedItemIds], originClass: "derived", methodId: `${ctx.kind}-signpost`, methodVersion: "v1", computedBy: `${ctx.kind}:${ctx.batch}`, inputs: [...ctx.inputs] }));
  }
  counts.signposts_registered = signpostIds.length;
  if (plan.connections.length) {
    const r = await writeEmission(deps, "", null, { entities: [], objects: [], connections: plan.connections.map((c) => ({ ...c, asserted_in: ctx.findingId ?? ctx.subject })), events: [], document_date: null, candidates: [], captureIds: [] }, new Set());
    for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + n;
    notes.push(...r.notes);
  }
  if (plan.gaps.length) {
    const q = await queueGaps(deps, plan.gaps, ctx, notes);
    counts.gaps_queued = q.queued;
    counts.gaps_deduplicated = q.deduplicated;
  }
  return { signpostIds, counts, notes };
}
