// New in DERIVE-3 (scripts/ci/new-files/derive-3.txt): penalty provisions as derived obligation objects. extractPenalty reads one verbatim span and returns the sanction class (a token of data/sanction-classes.json with the matched text as its basis), the statutory
// maximum, the cost formula and the enforcement start, each a verbatim fragment of the span; penaltyCandidates finds the penalty paragraphs of an item-bound capture (statute headings, numbered paragraphs, lettered annex parts) and withPenalties is the one hook
// deriveObligationObjects calls: it fills the penalty columns of every candidate, adds the penalty paragraphs, and resolves the obligation entity BEFORE minting (an entity the statutory schedule already authored for the article is reused, never duplicated).
// Code writes no sentence (ADR-050): a penalty object stores columns, tokens and fragments only.
import { createHash } from "node:crypto";

import { z } from "zod";

import { fetchAllByIdChunks, type Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";

import { tryParseDateAt } from "../extract/date-grammar";

import type { Candidate, CaptureRow, ExistingObject, ObjectItem, ObjectPlan } from "./derive-objects";
import objectRules from "./data/object-rules.json";
import { extractStatutory } from "./maximum";
import { classifyMode } from "./mode";
import classesJson from "./data/sanction-classes.json";

const strs = z.array(z.string().min(1)).min(1);
const FILE = z.object({
  trigger: z.object({ figureWindow: z.number().int().positive(), words: z.string(), figure: strs, liability: strs, memberState: strs, reference: strs, calculation: strs }),
  exclusions: z.array(z.object({ id: z.string(), pattern: z.string() })).min(1),
  classes: z.array(z.object({ token: z.string(), label: z.string(), patterns: strs })).min(1),
  costFormula: strs,
  figureFallback: strs,
  structure: z.object({ headings: z.array(z.object({ kind: z.string(), pattern: z.string(), paragraph: z.string(), sequence: z.enum(["number", "upper", "lower"]) })).min(1), maxSpan: z.number().int().positive() }),
  enforcementStart: strs,
}).parse(classesJson);
const rx = (p: string, flags = "i"): RegExp => new RegExp(p, flags);
const anyOf = (ps: readonly string[]): RegExp => rx(ps.map((p) => `(?:${p})`).join("|"));
const T = FILE.trigger;
const WORDS = rx(T.words, "gi");
const FIGURE = anyOf(T.figure);
const ROUTES = [["liability", anyOf(T.liability)], ["member_state", anyOf(T.memberState)], ["reference", anyOf(T.reference)], ["calculation", anyOf(T.calculation)]] as const;
const EXCLUSIONS = FILE.exclusions.map((e) => ({ id: e.id, re: rx(e.pattern, "gi") }));
const CLASSES = FILE.classes.map((c) => ({ token: c.token, res: c.patterns.map((p) => rx(p)) }));
const COST = FILE.costFormula.map((p) => rx(p));
const FALLBACK = FILE.figureFallback.map((p) => rx(p));
const LEAD = FILE.enforcementStart.map((p) => rx(p));
const CURRENCY_AMOUNT = rx(String.raw`(?:EUR|€|USD|US\$|\$|GBP|£)\s?\d[\d.,\s]*\d|\d[\d.,\s]*\d\s?(?:EUR|euros?)`, "gi");
const ST = FILE.structure;
const HEADINGS = ST.headings.map((h) => rx(h.pattern, "g"));

export interface PenaltyFinding {
  sanction_class: { token: string; fragment: string } | null;
  statutory_maximum: { fragment: string } | null;
  cost_formula: { fragment: string } | null;
  enforcement_start: { fragment: string; iso: string } | null;
  refused: string[];
}

/** Why `span` is not a penalty provision (null when it is): a penalty word that no exclusion covers, and a figure near it, a liability phrase, a Member-State clause, a reference to another paragraph's penalty or a calculation rule. */
function notPenalty(span: string): string | null {
  const gone = EXCLUSIONS.flatMap((e) => [...span.matchAll(e.re)].map((m) => ({ id: e.id, from: m.index, to: m.index + m[0].length })));
  const words = [...span.matchAll(WORDS)];
  if (!words.length) return "no_penalty_word";
  const kept = words.filter((w) => !gone.some((g) => w.index < g.to && g.from < w.index + w[0].length));
  if (!kept.length) return `excluded:${gone.find((g) => words.some((w) => w.index < g.to && g.from < w.index + w[0].length))?.id ?? "exclusion"}`;
  const near = kept.some((w) => FIGURE.test(span.slice(Math.max(0, w.index - T.figureWindow), w.index + w[0].length + T.figureWindow)));
  return near || ROUTES.some(([, re]) => re.test(span)) ? null : "penalty_word_without_trigger";
}

/** The reason a finding may not be written for this span, or null: every fragment is a verbatim substring of the span, and the enforcement date is the one the fragment states. */
function ungrounded(f: Pick<PenaltyFinding, "sanction_class" | "statutory_maximum" | "cost_formula" | "enforcement_start">, span: string): string | null {
  const fragments: [string, string | undefined][] = [["sanction_class", f.sanction_class?.fragment], ["statutory_maximum", f.statutory_maximum?.fragment], ["cost_formula", f.cost_formula?.fragment], ["enforcement_start", f.enforcement_start?.fragment]];
  const off = fragments.find(([, frag]) => frag !== undefined && !span.includes(frag));
  if (off) return `${off[0]}_not_in_span`;
  const e = f.enforcement_start;
  return e && !Array.from(e.fragment, (_, k) => k).some((k) => tryParseDateAt(e.fragment, k)?.iso === e.iso) ? "enforcement_start_iso_not_stated" : null;
}

/** The reason a candidate's sanction class may not be written (a session-authored candidate too): it is a token of the data file, and a pattern of that class is in the span (the token's basis). */
export function sanctionRefusal(c: { sanction_class?: string | null; verbatim_text: string }): string | null {
  if (c.sanction_class == null) return null;
  const cls = CLASSES.find((x) => x.token === c.sanction_class);
  if (!cls) return `sanction_class_unknown:${c.sanction_class}`;
  return cls.res.some((re) => re.test(c.verbatim_text)) ? null : `sanction_class_basis_not_in_span:${c.sanction_class}`;
}

const firstMatch = (res: readonly RegExp[], span: string): string | undefined => res.map((re) => re.exec(span)?.[0].trim()).find((x) => !!x);

/** What a penalty provision's span states; a span that is not a penalty provision gives nothing and the reason. Pure; every field passes the grounding check. */
export function extractPenalty(span: string): PenaltyFinding {
  const none: PenaltyFinding = { sanction_class: null, statutory_maximum: null, cost_formula: null, enforcement_start: null, refused: [] };
  const why = notPenalty(span);
  if (why) return { ...none, refused: [why] };
  const stated = extractStatutory(span);
  const refused = [...stated.refused];
  const hit = CLASSES.flatMap((c) => c.res.map((re) => ({ token: c.token, fragment: re.exec(span)?.[0].trim() }))).find((h) => !!h.fragment);
  if (!hit?.fragment) refused.push("no_sanction_class");
  const max = stated.maximum?.fragment ?? firstMatch(FALLBACK, span);
  const formula = firstMatch(COST, span) ?? stated.formula?.fragment;
  if (new Set((span.match(CURRENCY_AMOUNT) ?? []).map((a) => a.replace(/\s+/g, ""))).size > 1) refused.push("second_figure_not_taken");
  const found: Omit<PenaltyFinding, "refused"> = { sanction_class: hit?.fragment ? { token: hit.token, fragment: hit.fragment } : null, statutory_maximum: max ? { fragment: max } : null, cost_formula: formula ? { fragment: formula } : null, enforcement_start: null };
  for (const re of LEAD) {
    const lead = re.exec(span);
    const date = lead ? tryParseDateAt(span, lead.index + lead[0].length) : null;
    if (lead && date?.precision === "day") { found.enforcement_start = { fragment: span.slice(lead.index, lead.index + lead[0].length + date.skip + date.length), iso: date.iso }; break; }
  }
  const bad = ungrounded(found, span);
  return bad ? { ...none, refused: [...refused, bad] } : { ...found, refused };
}

// -- the penalty paragraphs of a capture ----------------------------------------------------------------------------------------------------------------------

interface Para { pinpoint: string; start: number; end: number }
const title = (s: string): string => s.replace(/\s+/g, " ").replace(/^(ANNEX|SCHEDULE|PART)\b/, (w) => `${w[0]}${w.slice(1).toLowerCase()}`);
type Sequence = "number" | "upper" | "lower";
/** The markers of a sequence inside [from, to): 1, 2, 3, 3a, 4 (or A, B, C; or (a), (b)); a marker out of sequence is a cross-reference or a sentence end, not a paragraph. */
function markers(text: string, from: number, to: number, pattern: string, seq: Sequence): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = [];
  const rank = (id: string): [number, string] => (seq === "number" ? [parseInt(id, 10), id.replace(/^\d+/, "")] : [id.charCodeAt(0), ""]);
  for (const m of text.slice(from, to).matchAll(rx(pattern, "g"))) {
    const id = m[1] as string;
    const [n, suffix] = rank(id);
    const [pn, ps] = out.length ? rank(out[out.length - 1]?.id as string) : [seq === "upper" ? 64 : seq === "lower" ? 96 : 0, ""];
    if (n === pn + 1 ? suffix === "" : seq === "number" && n === pn && suffix > ps) out.push({ id, at: from + m.index + m[0].indexOf(id) });
  }
  return out;
}
/** Every paragraph of every statute heading in the text: an Article's numbered paragraphs (`Article 16(3a)`), an Annex's lettered parts (`Annex IV Part B`), a Schedule's Parts and paragraphs, a section's lettered clauses, or the whole block when it has none. Slices of the raw text, never rewritten. */
function paragraphs(text: string): Para[] {
  const heads = HEADINGS.flatMap((re, k) => [...text.matchAll(re)].map((m) => ({ label: title(m[1] as string), at: m.index + m[0].indexOf(m[1] as string), unit: ST.headings[k] as (typeof ST.headings)[number] }))).sort((a, b) => a.at - b.at);
  let schedule = "";
  return heads.flatMap((h, i) => {
    if (h.unit.kind === "schedule") schedule = h.label;
    const label = h.unit.kind === "part" && schedule ? `${schedule} ${h.label}` : h.label;
    const end = heads[i + 1]?.at ?? text.length;
    const ms = markers(text, h.at, end, h.unit.paragraph, h.unit.sequence);
    if (!ms.length) return [{ pinpoint: label, start: h.at, end }];
    return ms.map((m, j) => ({ pinpoint: h.unit.sequence === "upper" ? `${label} Part ${m.id}` : `${label}(${m.id})`, start: m.at, end: ms[j + 1]?.at ?? end }));
  });
}
const sentenceEndAt = (t: string, i: number): boolean => /[.;]/.test(t[i - 1] ?? "") && /\s/.test(t[i] ?? "") && !/\d/.test(t[i - 2] ?? "");
const plainSpaceAt = (t: string, i: number): boolean => /\s/.test(t[i] ?? "") && /\D/.test(t[i - 1] ?? "") && /\D/.test(t[i + 1] ?? "");
/** The paragraph bounded at maxSpan: cut at the last sentence end, else at a space that touches no digit (never mid-figure); trailing amendment tags removed. */
function bounded(text: string, p: Para): string {
  let end = Math.min(p.end, p.start + ST.maxSpan);
  if (end < p.end) {
    const floor = p.start + 200;
    const back = (at: (t: string, i: number) => boolean): number => { let i = end; while (i > floor && !at(text, i)) i -= 1; return i > floor ? i : -1; };
    end = back(sentenceEndAt) > 0 ? back(sentenceEndAt) : back(plainSpaceAt) > 0 ? back(plainSpaceAt) : end;
  }
  return text.slice(p.start, end).trim().replace(/\s*▼\w+$/, "");
}
const pinKey = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface PenaltyInputs { candidates: readonly Candidate[]; itemsById: ReadonlyMap<string, ObjectItem>; captures: readonly CaptureRow[]; existing: readonly ExistingObject[]; holdersIn: (span: string) => string[] }
type Refusal = ObjectPlan["refused"][number];

/** The penalty paragraphs of one item-bound capture as candidates, with the refusals of those that carry a penalty word but no class. Pure. */
function penaltyCandidates(capture: CaptureRow, item: ObjectItem, holdersIn: (span: string) => string[] = () => []): { found: Candidate[]; refused: Refusal[] } {
  const text = capture.result_content ?? "";
  const found: Candidate[] = [];
  const refused: Refusal[] = [];
  const value = [item.canonical_instrument_key, item.instrument_identifier, item.title].map((s) => (typeof s === "string" ? s.trim() : "")).find(Boolean) ?? "";
  for (const p of paragraphs(text)) {
    const span = bounded(text, p);
    const f = extractPenalty(span);
    if (!f.sanction_class) {
      if (f.refused[0] !== "no_penalty_word") refused.push({ instrument_item_id: item.id, pinpoint_citation: p.pinpoint, reason: f.refused.find((r) => r === "no_sanction_class" || r === "penalty_word_without_trigger" || r.startsWith("excluded:")) ?? f.refused[0] ?? "no_sanction_class" });
      continue;
    }
    const verdict = classifyMode(span, { title: item.title, identifier: item.instrument_identifier });
    found.push({ instrument_item_id: item.id, capture_id: capture.id, pinpoint_citation: p.pinpoint, verbatim_text: span, duty_holder_class: holdersIn(span), applicability_trigger: { attribute: objectRules.triggerAttribute, value }, plain_language: null, mode: verdict.modes.length ? verdict.modes : null, sanction_class: f.sanction_class.token, statutory_maximum: f.statutory_maximum?.fragment ?? null, cost_formula: f.cost_formula?.fragment ?? null, enforcement_start: f.enforcement_start?.iso ?? null });
  }
  return { found, refused };
}

/**
 * The obligation entity a penalty candidate takes BEFORE it is minted: the statutory schedule (ARM-2) may have authored an entity for the article (the FuelEU Article 23 penalty and Annex IV Part B formula) that no object carries yet. Each such entity goes once to the candidate of
 * its instrument whose pinpoint the schedule rows cite most (their `inputs[].article`), else the first whose pinpoint the entity's canonical name contains. Everything else mints through the guard as before.
 */
async function resolveEntities(sb: Db, list: Candidate[], items: ReadonlyMap<string, ObjectItem>): Promise<Candidate[]> {
  const instrumentOf = new Map<string, string>();
  for (const r of await fetchAllByIdChunks<{ id: string; instrument_entity_id: string | null }>([...new Set(list.map((c) => c.instrument_item_id))].filter((id) => items.has(id)), async (slice) => {
    const { data, error } = await admitItems(sb.from("intelligence_items").select("id, instrument_entity_id").in("id", slice));
    if (error) throw new Error(`penalty: intelligence_items read failed: ${error.message}`);
    return data ?? [];
  })) if (r.instrument_entity_id) instrumentOf.set(r.id, r.instrument_entity_id);
  const schedule = await fetchAllByIdChunks<{ computation_id: string; entity_id: string; obligation_id: string; inputs: unknown }>([...new Set(instrumentOf.values())], async (slice) => {
    const { data, error } = await sb.from("statutory_computations").select("computation_id, entity_id, obligation_id, inputs").in("entity_id", slice);
    if (error) throw new Error(`penalty: statutory_computations read failed: ${error.message}`);
    return data ?? [];
  }, { manyPerId: true });
  const ids = [...new Set(schedule.map((s) => s.obligation_id))];
  const read = async (table: "obligation_objects" | "entities", column: string, select: string, slice: string[]) => {
    const { data, error } = await sb.from(table).select(select).in(column, slice);
    if (error) throw new Error(`penalty: ${table} read failed: ${error.message}`);
    return (data ?? []) as unknown as Record<string, string>[];
  };
  const held = new Set((await fetchAllByIdChunks(ids, (slice) => read("obligation_objects", "obligation_id", "obligation_id", slice), { manyPerId: true })).map((o) => o.obligation_id));
  const names = await fetchAllByIdChunks(ids.filter((i) => !held.has(i)), (slice) => read("entities", "entity_id", "entity_id, canonical_name", slice));
  const cited = (s: { inputs: unknown }): string[] => (Array.isArray(s.inputs) ? s.inputs : []).flatMap((i) => (typeof (i as { article?: unknown })?.article === "string" ? [pinKey((i as { article: string }).article)] : []));
  const out = [...list];
  for (const entity of names) {
    const rows = schedule.filter((s) => s.obligation_id === entity.entity_id);
    const scored = out.flatMap((c, i) => {
      if (instrumentOf.get(c.instrument_item_id) !== rows[0]?.entity_id || c.obligation_id) return [];
      const pin = pinKey(c.pinpoint_citation);
      const n = rows.filter((r) => cited(r).includes(pin)).length;
      return n > 0 || (entity.canonical_name ?? "").toLowerCase().includes(pin.replace(/\(.*$/, "")) ? [{ i, n }] : [];
    }).sort((a, b) => b.n - a.n || a.i - b.i)[0];
    if (scored) out[scored.i] = { ...(out[scored.i] as Candidate), obligation_id: entity.entity_id as string };
  }
  return out;
}

/** The hook of deriveObligationObjects: fills the penalty columns a candidate leaves null from its own span, adds the penalty paragraphs of the item-bound captures (a pinpoint that already has an object, or a candidate, is not re-spanned), and resolves the entities of the new ones. */
export async function withPenalties(sb: Db, input: PenaltyInputs): Promise<{ candidates: Candidate[]; refused: Refusal[] }> {
  const filled = input.candidates.map((c) => {
    const f = extractPenalty(c.verbatim_text);
    return { ...c, sanction_class: c.sanction_class ?? f.sanction_class?.token ?? null, statutory_maximum: c.statutory_maximum ?? f.statutory_maximum?.fragment ?? null, cost_formula: c.cost_formula ?? f.cost_formula?.fragment ?? null, enforcement_start: c.enforcement_start ?? f.enforcement_start?.iso ?? null };
  });
  const taken = new Set([...input.existing.map((o) => `${o.instrument_item_id}|${pinKey(o.pinpoint_citation)}`), ...filled.map((c) => `${c.instrument_item_id}|${pinKey(c.pinpoint_citation)}`)]);
  const refused: Refusal[] = [];
  const reported = new Set<string>();
  const added: Candidate[] = [];
  // the newest capture of a text is read first (the consolidated text in force answers before the original it amends); a page captured again with the same text is read once
  const seen = new Set<string>();
  for (const cap of [...input.captures].sort((a, b) => (b.searched_at ?? "").localeCompare(a.searched_at ?? "") || a.id.localeCompare(b.id))) {
    const item = input.itemsById.get(cap.intelligence_item_id);
    const key = `${cap.intelligence_item_id}|${createHash("sha1").update(cap.result_content ?? "").digest("hex")}`;
    if (!item || !cap.result_content || seen.has(key)) continue;
    seen.add(key);
    const { found, refused: no } = penaltyCandidates(cap, item, input.holdersIn);
    for (const r of no) if (!taken.has(`${item.id}|${pinKey(r.pinpoint_citation ?? "")}`) && !reported.has(`${item.id}|${r.pinpoint_citation}`)) { reported.add(`${item.id}|${r.pinpoint_citation}`); refused.push(r); }
    for (const c of found) {
      const key = `${c.instrument_item_id}|${pinKey(c.pinpoint_citation)}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const holders = c.duty_holder_class.length ? c.duty_holder_class : [...new Set([...filled, ...added].filter((o) => o.instrument_item_id === item.id).flatMap((o) => o.duty_holder_class))];
      if (holders.length) added.push({ ...c, duty_holder_class: holders });
      else refused.push({ instrument_item_id: item.id, pinpoint_citation: c.pinpoint_citation, reason: "duty_holder_unresolved" });
    }
  }
  return { candidates: [...filled, ...(await resolveEntities(sb, added, input.itemsById))], refused };
}
