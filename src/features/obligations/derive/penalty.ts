// New in DERIVE-3 (scripts/ci/new-files/derive-3.txt), ADR-053: a penalty object arises from a FORMAL code, never from an English cue. The statutory schedule (statutory_computations) cites the Article or Annex pinpoint it transcribes (inputs[].article) and names its
// formula by a formal id; withPenalties finds that pinpoint's paragraph in an item-bound capture by the Article / ANNEX heading grammar (Article 23(5), Annex IV Part B), makes it a candidate, and resolves the obligation entity the schedule already authored BEFORE minting, so the
// schedule rows join the object. The figure fragments are extractStatutory's (DERIVE-2, grounded in the span); sanction_class is the closed map formulaClass in data/sanction-classes.json. Code writes no sentence (ADR-050); a reader classifies everything else.
import { createHash } from "node:crypto";

import { z } from "zod";

import { fetchAllByIdChunks, type Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import { currentObligationObjects } from "@/core/workspace";

import type { Candidate, CaptureRow, ExistingObject, ObjectItem, ObjectPlan } from "./derive-objects";
import objectRules from "./data/object-rules.json";
import { extractStatutory } from "./maximum";
import { classifyMode } from "./mode";
import classesJson from "./data/sanction-classes.json";

const FILE = z.object({ classes: z.array(z.object({ token: z.string().min(1), label: z.string().min(1) })).min(1), formulaClass: z.record(z.string(), z.string()) }).parse(classesJson);
const TOKENS: ReadonlySet<string> = new Set(FILE.classes.map((c) => c.token));
for (const [formula, token] of Object.entries(FILE.formulaClass)) if (!TOKENS.has(token)) throw new Error(`sanction-classes.json formulaClass "${formula}": "${token}" is not a class token`);
const MAX_SPAN = 1200;

/** The reason a candidate's sanction class may not be written (a session-authored candidate too): it is a token of the data file. */
export function sanctionRefusal(c: { sanction_class?: string | null }): string | null {
  return c.sanction_class == null || TOKENS.has(c.sanction_class) ? null : `sanction_class_unknown:${c.sanction_class}`;
}

// -- the paragraph of a cited pinpoint ------------------------------------------------------------------------------------------------------------------------

interface Para { pinpoint: string; start: number; end: number }
const HEADINGS = [
  { re: /(?:^|[.;:)\]]\s|▼\w+\s)(Article\s+\d+[a-z]{0,2})\s+(?=[A-Z▼])/g, paragraph: /(?:^|\s)(\d{1,2}[a-z]?)\.\s+(?=[A-Z(])/g, lettered: false },
  { re: /\b(ANNEX\s+[IVX]+)\s+(?=[A-Z])/g, paragraph: /(?:^|\s)([A-Z])\.\s+(?=[A-Z])/g, lettered: true },
];
const label = (s: string): string => s.replace(/\s+/g, " ").replace(/^ANNEX\b/, "Annex");
const pinKey = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The markers of a sequence inside the block: 1, 2, 3, 3a, 4 (or A, B, C); a marker out of sequence is a cross-reference or a sentence end, not a paragraph. */
function markers(block: string, pattern: RegExp, lettered: boolean): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = [];
  const rank = (id: string): [number, string] => (lettered ? [id.charCodeAt(0), ""] : [parseInt(id, 10), id.replace(/^\d+/, "")]);
  for (const m of block.matchAll(pattern)) {
    const id = m[1] as string;
    const [n, suffix] = rank(id);
    const [pn, ps] = out.length ? rank(out[out.length - 1]?.id as string) : [lettered ? 64 : 0, ""];
    if (n === pn + 1 ? suffix === "" : !lettered && n === pn && suffix > ps) out.push({ id, at: m.index + m[0].indexOf(id) });
  }
  return out;
}
/** Every paragraph of every Article and Annex heading: `Article 16(3a)`, `Annex IV Part B`, or the whole block when it has no marker. Slices of the raw text, never rewritten. */
function paragraphs(text: string): Para[] {
  const heads = HEADINGS.flatMap((h) => [...text.matchAll(h.re)].map((m) => ({ name: label(m[1] as string), at: m.index + m[0].indexOf(m[1] as string), h }))).sort((a, b) => a.at - b.at);
  return heads.flatMap((head, i) => {
    const end = heads[i + 1]?.at ?? text.length;
    const ms = markers(text.slice(head.at, end), head.h.paragraph, head.h.lettered);
    if (!ms.length) return [{ pinpoint: head.name, start: head.at, end }];
    return ms.map((m, j) => ({ pinpoint: head.h.lettered ? `${head.name} Part ${m.id}` : `${head.name}(${m.id})`, start: head.at + m.at, end: ms[j + 1] ? head.at + (ms[j + 1] as { at: number }).at : end }));
  });
}
const sentenceEndAt = (t: string, i: number): boolean => /[.;]/.test(t[i - 1] ?? "") && /\s/.test(t[i] ?? "") && !/\d/.test(t[i - 2] ?? "");
const plainSpaceAt = (t: string, i: number): boolean => /\s/.test(t[i] ?? "") && /\D/.test(t[i - 1] ?? "") && /\D/.test(t[i + 1] ?? "");
/** The paragraph bounded at MAX_SPAN: cut at the last sentence end, else at a space that touches no digit (never mid-figure); trailing amendment tags removed. */
function bounded(text: string, p: Para): string {
  let end = Math.min(p.end, p.start + MAX_SPAN);
  if (end < p.end) {
    const floor = p.start + 200;
    const back = (at: (t: string, i: number) => boolean): number => { let i = end; while (i > floor && !at(text, i)) i -= 1; return i > floor ? i : -1; };
    end = back(sentenceEndAt) > 0 ? back(sentenceEndAt) : back(plainSpaceAt) > 0 ? back(plainSpaceAt) : end;
  }
  return text.slice(p.start, end).trim().replace(/\s*▼\w+$/, "");
}

// -- the hook ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface PenaltyInputs { candidates: readonly Candidate[]; itemsById: ReadonlyMap<string, ObjectItem>; captures: readonly CaptureRow[]; existing: readonly ExistingObject[] }
type Refusal = ObjectPlan["refused"][number];
interface Cited { pinpoint: string; token: string | null; ids: Map<string, number> }
const readRows = async <T>(sb: Db, table: string, columns: string, column: string, ids: readonly string[], more?: (q: never) => never): Promise<T[]> =>
  fetchAllByIdChunks<T>(ids, async (slice) => {
    const base = sb.from(table).select(columns).in(column, slice);
    const { data, error } = await (more ? more(base as never) : base);
    if (error) throw new Error(`penalty: ${table} read failed: ${(error as { message: string }).message}`);
    return (data ?? []) as T[];
  }, { manyPerId: true });

/** The pinpoints the statutory schedule cites for each item's instrument, by a penalty formula the data file maps: pinpoint -> { the formula's token, the obligation entities its rows name with the row counts }. */
async function citedPinpoints(sb: Db, items: ReadonlyMap<string, ObjectItem>): Promise<Map<string, Map<string, Cited>>> {
  const entityOf = new Map((await readRows<{ id: string; instrument_entity_id: string | null }>(sb, "intelligence_items", "id, instrument_entity_id", "id", [...items.keys()], (q) => admitItems(q) as never)).flatMap((r) => (r.instrument_entity_id ? [[r.id, r.instrument_entity_id] as const] : [])));
  const rows = await readRows<{ entity_id: string; obligation_id: string; formula_id: string; inputs: unknown }>(sb, "statutory_computations", "entity_id, obligation_id, formula_id, inputs", "entity_id", [...new Set(entityOf.values())]);
  const out = new Map<string, Map<string, Cited>>();
  for (const [itemId, entity] of entityOf) {
    const cited = new Map<string, Cited>();
    for (const r of rows.filter((x) => x.entity_id === entity && x.formula_id in FILE.formulaClass)) {
      for (const article of (Array.isArray(r.inputs) ? r.inputs : []).flatMap((i) => (typeof (i as { article?: unknown })?.article === "string" ? [(i as { article: string }).article] : []))) {
        const key = pinKey(article);
        const token = FILE.formulaClass[r.formula_id] as string;
        const have = cited.get(key);
        cited.set(key, { pinpoint: article, token: have && have.token !== token ? null : token, ids: new Map([...(have?.ids ?? []), [r.obligation_id, (have?.ids.get(r.obligation_id) ?? 0) + 1]]) });
      }
    }
    if (cited.size) out.set(itemId, cited);
  }
  return out;
}

/**
 * The hook of deriveObligationObjects: a candidate for each pinpoint the schedule cites that an item-bound capture holds and no object or candidate already has (a pinpoint that has an object is not re-spanned). Each takes the obligation entity the schedule's rows name, the entity that
 * more rows cite first, once, when no object holds it yet; the rows then join the object on obligation_id. A cited pinpoint no capture holds, and one with no duty holder to inherit from the item's other candidates, is refused with the reason.
 */
export async function withPenalties(sb: Db, input: PenaltyInputs): Promise<{ candidates: Candidate[]; refused: Refusal[] }> {
  const cited = await citedPinpoints(sb, input.itemsById);
  const held = new Set((await readRows<{ obligation_id: string }>(sb, "obligation_objects", "obligation_id", "obligation_id", [...cited.values()].flatMap((m) => [...m.values()].flatMap((c) => [...c.ids.keys()])))).map((o) => o.obligation_id));
  // each free entity goes to the cited pinpoint whose rows name it most (ties by pinpoint), never to whichever comes first in the text
  const owner = new Map<string, string>();
  for (const wanted of cited.values()) for (const [key, want] of wanted) for (const [id, n] of want.ids) if (!held.has(id) && n > (wanted.get(owner.get(id) ?? "")?.ids.get(id) ?? 0)) owner.set(id, key);
  const taken = new Set([...input.existing.map((o) => `${o.instrument_item_id}|${pinKey(o.pinpoint_citation)}`), ...input.candidates.map((c) => `${c.instrument_item_id}|${pinKey(c.pinpoint_citation)}`)]);
  const added: Candidate[] = [];
  const refused: Refusal[] = [];
  const seen = new Set<string>();
  for (const cap of [...input.captures].sort((a, b) => (b.searched_at ?? "").localeCompare(a.searched_at ?? "") || a.id.localeCompare(b.id))) {
    const item = input.itemsById.get(cap.intelligence_item_id);
    const wanted = cited.get(cap.intelligence_item_id);
    const text = cap.result_content ?? "";
    const digest = `${cap.intelligence_item_id}|${createHash("sha1").update(text).digest("hex")}`;
    if (!item || !wanted || !text || seen.has(digest)) continue;
    seen.add(digest);
    for (const p of paragraphs(text)) {
      const want = wanted.get(pinKey(p.pinpoint));
      const key = `${item.id}|${pinKey(p.pinpoint)}`;
      if (!want || taken.has(key)) continue;
      taken.add(key);
      const span = bounded(text, p);
      // the duty holders of the instrument's own objects, current ones held and candidates of this batch: the span names none, the DB requires one, and the basis says which objects supplied them
      const sources = [...currentObligationObjects<ExistingObject>(input.existing).filter((o) => o.instrument_item_id === item.id).map((o) => ({ ref: o.obligation_id, holders: o.duty_holder_class ?? [] })), ...[...input.candidates, ...added].filter((c) => c.instrument_item_id === item.id).map((c) => ({ ref: `candidate:${c.pinpoint_citation}`, holders: c.duty_holder_class }))].filter((s) => s.holders.length);
      const holders = [...new Set(sources.flatMap((s) => s.holders))];
      if (!holders.length) { refused.push({ instrument_item_id: item.id, pinpoint_citation: want.pinpoint, reason: "duty_holder_unresolved" }); continue; }
      const stated = extractStatutory(span);
      const mode = classifyMode(span, { title: item.title, identifier: item.instrument_identifier });
      const entity = [...want.ids.keys()].filter((id) => !held.has(id) && owner.get(id) === pinKey(p.pinpoint)).sort()[0];
      if (entity) held.add(entity);
      added.push({ instrument_item_id: item.id, capture_id: cap.id, pinpoint_citation: want.pinpoint, verbatim_text: span, duty_holder_class: holders, holder_basis: sources.map((s) => s.ref), applicability_trigger: { attribute: objectRules.triggerAttribute, value: item.canonical_instrument_key || item.instrument_identifier || item.title || "" }, plain_language: null, mode: mode.modes.length ? mode.modes : null, sanction_class: want.token, statutory_maximum: stated.maximum?.fragment ?? null, cost_formula: stated.formula?.fragment ?? null, ...(entity ? { obligation_id: entity } : {}) });
    }
  }
  for (const [itemId, wanted] of cited) for (const [key, want] of wanted) if (!taken.has(`${itemId}|${key}`)) refused.push({ instrument_item_id: itemId, pinpoint_citation: want.pinpoint, reason: "pinpoint_not_in_capture" });
  return { candidates: [...input.candidates, ...added], refused };
}
