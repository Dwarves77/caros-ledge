// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt), UNIFIED-PRB-DESIGN section 1, ADR-053: the validator of the reader's typed blocks. An item-brief entry may carry entity_ids, obligation_fields, connections, events, document_date and new_entity_candidates; every value
// that is present carries a quote {capture_id, text} that must be in a capture of THE ITEM: the locate door (CAPTURE-STRUCT-1) returns the capture's own slice, the exact isVerbatim rule runs on that slice, and the slice is what is stored. Closed vocabularies are checked as tokens,
// dates as ISO dates the quote states, quantities through the figure parser and statutoryUnit, an entity id against the menu (or a formal code the crosswalk resolves), a relation against couplings.json. Pure: the caller supplies the live material. A refusal names the block, the index and the token.
import { stated } from "@/core/brief/rules";
import { RELATIONS } from "@/core/coupling";
import { isVerbatim } from "@/core/contracts/verbatim";
import { isKindToken } from "@/core/entities/kinds";
import { DUTY_HOLDER_TOKEN, isValid, LEG_MODE_CODES } from "@/core/contracts/vocabularies";
import { normaliseTermKey, PROPOSED_ENTITY_KIND, proposedEntityId } from "@/core/vocabulary/adopted";
import { type Precision, findFigures, foldHtmlSpace, isFigure, statutoryUnit, tryParseDateOrBareYearAt } from "@/core/parse";
import { groundingRefusal } from "@/features/obligations/derive/maximum";
import { sanctionRefusal } from "@/features/obligations/derive/penalty";
import { EVENT_KINDS } from "@/features/obligations/kinds";

import { isObj, nonEmpty, type Locate, type Obj } from "../../kit/session-batch";

export interface Quote { capture_id: string; text: string }
export interface EmitLive {
  captures: ReadonlyMap<string, string>;
  /** Every id a reader may write, to the active entity it names: the menu, a cl: id of a live entity the entry names, a formal code the crosswalk resolves, a closed mode or hub token. Anything else is refused. */
  ids: ReadonlyMap<string, string>;
  /** The item's current obligation objects: obligation_id to pinpoint. */
  objects: ReadonlyMap<string, string>;
  locate: Locate | null;
  /** The live entity a candidate name already is, by `${kind}|${normalised name}` (G3 dedup): a candidate whose kind and normalised name an active entity already holds reuses that entity's id and mints nothing. */
  named?: ReadonlyMap<string, string>;
}
export interface ObjectPlan { obligation_id: string | null; pinpoint: string; provision: Quote; set: Obj; quotes: Record<string, Quote>; entity_ids: string[] }
export interface EmissionPlan {
  entities: { entity_id: string; quote: Quote }[];
  objects: ObjectPlan[];
  connections: { parent: string; child: string; relation: string; reason_token: string; quote: Quote; /** The record that asserted the connection when no item did (a synthesis finding or the cluster it analysed): carried in the relation's basis. */ asserted_in?: string }[];
  events: { event_kind: string; event_date: string; date_precision: "day" | "month" | "year"; quote: Quote; mode: string | null; entity_ids: string[] }[];
  document_date: { date: string; quote: Quote } | null;
  /** Entities the reader mints (G3): a new entity with the kind, the canonical name and the quote that names it; usable in the same entry by `entity_id`. `existing` when the live graph already holds it. */
  candidates: { proposed_kind: string; kind: string; canonical_name: string; entity_id: string; existing: boolean; quote: Quote }[];
  /** Every capture of the item (a capture-backed event is judged stale against them). */
  captureIds: string[];
}
const BLOCKS = ["entity_ids", "obligation_fields", "connections", "events", "document_date", "new_entity_candidates"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LOCODE = /(?<![A-Za-z0-9])[A-Z]{2}[A-Z2-9]{3}(?![A-Za-z0-9])/;
const SYMMETRIC = new Set(["competes_for_feedstock", "shares_grid_zone", "corridor_links"]);
const FIELDS = ["mode", "sanction_class", "statutory_maximum", "cost_formula", "enforcement_start", "due_date", "mandated_quantity", "in_force_end", "duty_holder_class", "binding_position", "applicability_trigger"] as const;
const STEM = { year: 4, month: 7, day: 10 } as const;
const RANK = { year: 0, month: 1, day: 2 } as const;
/** The most precise reading the shared date parser finds in the quote of the date `iso` stored at `precision` (a day in the stored month or year counts); null when the quote states that month or year nowhere. */
const mostPrecise = (text: string, iso: string, precision: "month" | "year"): Precision | null => {
  const stem = iso.slice(0, STEM[precision]);
  let best: Precision | null = null;
  [...text].forEach((_, i) => { const m = tryParseDateOrBareYearAt(text, i); if (m !== null && m.iso.startsWith(stem) && (best === null || RANK[m.precision] > RANK[best])) best = m.precision; });
  return best;
};
const isoDate = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
export const hasEmission = (e: Obj): boolean => BLOCKS.some((b) => e[b] !== undefined);

/** The value of one obligation field, checked as its column is checked at the database, against the slice that states it; the reason it may not be written, or the value to write. */
function fieldValue(col: (typeof FIELDS)[number], v: unknown, slice: string, precision?: unknown): { ok: true; set: Obj } | { ok: false; why: string } {
  const bad = (why: string) => ({ ok: false as const, why });
  const date = (c: string) => (isoDate(v) ? (stated(slice, v) ? { ok: true as const, set: { [c]: v } } : bad(`${c} ${v} is not stated in the quote`)) : bad(`${c} must be an ISO date (YYYY-MM-DD)`));
  switch (col) {
    case "mode": return Array.isArray(v) && v.length && v.every((m) => LEG_MODE_CODES.includes(m as string)) ? { ok: true, set: { mode: v } } : bad(`mode must be leg-mode tokens of ${LEG_MODE_CODES.join(", ")}`);
    case "sanction_class": return typeof v === "string" && !sanctionRefusal({ sanction_class: v }) ? { ok: true, set: { sanction_class: v } } : bad(`sanction_class ${JSON.stringify(v)} is not a closed token`);
    case "statutory_maximum": case "cost_formula": { const why = typeof v === "string" ? groundingRefusal(col, v, slice) : "must be text"; return why ? bad(`${col}: ${why}`) : { ok: true, set: { [col]: v } }; }
    case "enforcement_start": case "in_force_end": return date(col);
    // G3: a due date carries the precision its quote supports (day, month or year), stored normalised, and the most precise date the quote states (D1), as an event's date does.
    case "due_date": {
      const p = precision === undefined ? "day" : precision;
      if (p !== "day" && p !== "month" && p !== "year") return bad("due_date precision must be day, month or year");
      if (!isoDate(v)) return bad("due_date must be an ISO date (YYYY-MM-DD)");
      if (p === "month" && !v.endsWith("-01")) return bad(`due_date month precision needs the first of the month (YYYY-MM-01), not ${v}`);
      if (p === "year" && !v.endsWith("-01-01")) return bad(`due_date year precision needs YYYY-01-01, not ${v}`);
      if (p === "day") return stated(slice, v) ? { ok: true, set: { due_date: v, due_date_precision: "day" } } : bad(`due_date ${v} is not stated in the quote`);
      const best = mostPrecise(slice, v, p);
      if (best === null) return bad(`the quote does not state a ${p} date ${v} as a month and year or a year`);
      if (best !== p) return bad(`the quote states a more precise ${best} date inside ${v}: store the most precise date the quote states, not ${p} precision`);
      return { ok: true, set: { due_date: v, due_date_precision: p } };
    }
    case "mandated_quantity": {
      const q = v as { value?: unknown; unit?: unknown };
      const unit = isObj(v) && typeof q.unit === "string" ? statutoryUnit(q.unit) : null;
      if (!isObj(v) || typeof q.value !== "number" || !Number.isFinite(q.value) || !unit) return bad("mandated_quantity must be { value: number, unit } with a unit statutoryUnit knows");
      return findFigures(foldHtmlSpace(slice)).some((h) => isFigure(h.result) && Number(h.result.value) === q.value) ? { ok: true, set: { mandated_quantity: q.value, mandated_unit: unit } } : bad(`mandated_quantity ${q.value} is not stated in the quote`);
    }
    case "duty_holder_class": return Array.isArray(v) && v.length && v.every((c) => typeof c === "string" && DUTY_HOLDER_TOKEN.test(c)) ? { ok: true, set: { duty_holder_class: v } } : bad("duty_holder_class must be one or more snake_case tokens (the class is open: name the duty holder the quote names)");
    case "binding_position": return isValid("binding_position", v) ? { ok: true, set: { binding_position: v } } : bad(`binding_position ${JSON.stringify(v)} is not a closed token`);
    case "applicability_trigger": return isObj(v) && nonEmpty(v.attribute) && nonEmpty(v.value) ? { ok: true, set: { applicability_trigger: { attribute: v.attribute, value: v.value } } } : bad("applicability_trigger must be { attribute, value }, both non-empty");
  }
}

/** The one quote locator (typed blocks and metadata refreshes): { capture_id, text } to the capture's own exact slice, or the reason it is not in a capture of the item. */
export function quoteIn(live: Pick<EmitLive, "captures" | "locate">, v: unknown): Quote | string {
  if (!isObj(v) || !nonEmpty(v.capture_id) || !nonEmpty(v.text)) return "quote must be { capture_id, text }";
  const cap = live.captures.get(v.capture_id);
  if (cap === undefined) return `capture ${v.capture_id} is not a capture of this item`;
  const slice = live.locate?.(cap, v.text) ?? null;
  return slice === null || !isVerbatim(cap, slice) ? `the quote is not in capture ${v.capture_id}: ${JSON.stringify(v.text.slice(0, 80))}` : { capture_id: v.capture_id, text: slice };
}

/** Validate the typed blocks of ONE entry against the item's live material. No block, no work; with a block and no locate door the entry is refused (the door is wired by the turn). */
export function validateEmission(entry: Obj, tag: string, live: EmitLive): { errors: string[]; plan: EmissionPlan | null } {
  if (!hasEmission(entry)) return { errors: [], plan: null };
  const errors: string[] = [];
  const err = (at: string, msg: string): null => (errors.push(`${tag} ${at}: ${msg}`), null);
  if (!live.locate) return { errors: [`${tag}: the locate door is not wired, so a quote cannot be located and the typed blocks are refused`], plan: null };
  const quote = (v: unknown, at: string): Quote | null => { const q = quoteIn(live, v); return typeof q === "string" ? err(at, q) : q; };
  const entityOf = (tokenValue: unknown, at: string): string | null => {
    const id = typeof tokenValue === "string" ? (live.ids.get(tokenValue) ?? (candidateIds.has(tokenValue) ? tokenValue : undefined)) : undefined;
    return id ?? (err(at, `unknown entity id ${JSON.stringify(tokenValue)}: it is not on the candidate menu and no formal code resolves it`));
  };
  const candidateIds = new Set<string>();
  const list = (b: string): unknown[] | null => (entry[b] === undefined ? null : Array.isArray(entry[b]) ? (entry[b] as unknown[]) : (err(b, "must be an array")));
  const plan: EmissionPlan = { entities: [], objects: [], connections: [], events: [], document_date: null, candidates: [], captureIds: [...live.captures.keys()] };
  (list("new_entity_candidates") ?? []).forEach((c, i) => {
    const at = `new_entity_candidates[${i}]`;
    if (!isObj(c) || !isKindToken(c.proposed_kind) || !nonEmpty(c.canonical_name)) return err(at, "must be { proposed_kind (a snake_case token: organisation, technology, person, port, or a kind the text names), canonical_name, quote }");
    const q = quote(c.quote, `${at}.quote`);
    if (!q) return;
    if (!norm(q.text).includes(norm(c.canonical_name))) return err(at, `the name ${JSON.stringify(c.canonical_name)} does not occur inside its quote`);
    if (c.proposed_kind === "port" && LOCODE.test(q.text)) return err(at, "the quote carries a UN/LOCODE: write UNLOCODE:<code> in entity_ids, a port is never proposed when a formal code names it");
    const kind = (PROPOSED_ENTITY_KIND as Record<string, string>)[c.proposed_kind] ?? c.proposed_kind;
    const key = normaliseTermKey(c.canonical_name);
    const held = live.named?.get(`${kind}|${key}`);
    const entityId = held ?? proposedEntityId(kind, key);
    candidateIds.add(entityId);
    plan.candidates.push({ proposed_kind: c.proposed_kind, kind, canonical_name: c.canonical_name.trim(), entity_id: entityId, existing: held !== undefined, quote: q });
  });
  (list("entity_ids") ?? []).forEach((e, i) => {
    const at = `entity_ids[${i}]`;
    if (!isObj(e)) return err(at, "must be { entity_id, quote }");
    const id = entityOf(e.entity_id, at);
    const q = quote(e.quote, `${at}.quote`);
    if (id && q) plan.entities.push({ entity_id: id, quote: q });
  });
  (list("obligation_fields") ?? []).forEach((o, i) => {
    const at = `obligation_fields[${i}]`;
    if (!isObj(o) || (o.obligation_id === undefined) === (o.pinpoint === undefined) || !isObj(o.fields)) return err(at, "must be { obligation_id | pinpoint, provision: quote, fields: { <column>: { value, quote } } }");
    const prior = typeof o.obligation_id === "string" ? live.objects.get(o.obligation_id) : undefined;
    if (o.obligation_id !== undefined && prior === undefined) return err(at, `obligation_id ${JSON.stringify(o.obligation_id)} is not an object of this item`);
    const pinpoint = prior ?? (typeof o.pinpoint === "string" ? o.pinpoint.replace(/\s+/g, " ").trim() : "");
    if (!pinpoint) return err(at, "pinpoint must be non-empty text");
    const existing = prior !== undefined || [...live.objects.values()].some((p) => norm(p) === norm(pinpoint));
    const provision = quote(o.provision, `${at}.provision`);
    const out: ObjectPlan = { obligation_id: typeof o.obligation_id === "string" ? o.obligation_id : null, pinpoint, provision: provision as Quote, set: {}, quotes: {}, entity_ids: [] };
    for (const [col, f] of Object.entries(o.fields)) {
      if (!(FIELDS as readonly string[]).includes(col)) { err(at, `unknown field ${JSON.stringify(col)} (fields: ${FIELDS.join(", ")})`); continue; }
      if (!isObj(f)) { err(`${at}.${col}`, "must be { value, quote }"); continue; }
      const q = quote(f.quote, `${at}.${col}.quote`);
      if (provision && q && q.capture_id !== provision.capture_id) err(`${at}.${col}`, "the quote is in another capture than the provision");
      const v = q ? fieldValue(col as (typeof FIELDS)[number], f.value, q.text, f.precision) : null;
      if (v && !v.ok) err(`${at}.${col}`, v.why);
      if (q && v?.ok) { Object.assign(out.set, v.set); out.quotes[col] = q; }
    }
    if (!existing) for (const need of ["duty_holder_class", "binding_position", "applicability_trigger"]) if (out.set[need] === undefined) err(at, `a new object needs ${need} (the database refuses it otherwise)`);
    for (const [k, id] of (Array.isArray(o.entity_ids) ? o.entity_ids : []).entries()) { const e = entityOf(id, `${at}.entity_ids[${k}]`); if (e) out.entity_ids.push(e); }
    if (provision) plan.objects.push(out);
  });
  (list("connections") ?? []).forEach((c, i) => {
    const at = `connections[${i}]`;
    if (!isObj(c) || !isKindToken(c.relation) || typeof c.reason_token !== "string" || !/^[a-z][a-z0-9_]{2,39}$/.test(c.reason_token)) return err(at, `must be { from_entity_id, to_entity_id, relation (a snake_case token; the usual ones: ${RELATIONS.join(", ")}), reason_token (snake_case), quote }`);
    const [from, to, q] = [entityOf(c.from_entity_id, `${at}.from_entity_id`), entityOf(c.to_entity_id, `${at}.to_entity_id`), quote(c.quote, `${at}.quote`)];
    if (from === to && from) return err(at, "an entity cannot connect to itself");
    if (!from || !to || !q) return;
    const flip = SYMMETRIC.has(c.relation as string) && from > to;
    plan.connections.push({ parent: flip ? to : from, child: flip ? from : to, relation: c.relation as string, reason_token: c.reason_token, quote: q });
  });
  (list("events") ?? []).forEach((ev, i) => {
    const at = `events[${i}]`;
    if (!isObj(ev) || !(EVENT_KINDS as readonly unknown[]).includes(ev.event_kind) || !isoDate(ev.event_date)) return err(at, `must be { event_kind (${EVENT_KINDS.join(", ")}), event_date (ISO), quote, mode?, entity_ids? }`);
    const precision = ev.date_precision === undefined ? "day" : ev.date_precision;
    if (precision !== "day" && precision !== "month" && precision !== "year") return err(at, "date_precision must be day, month or year");
    if (precision === "month" && !ev.event_date.endsWith("-01")) return err(at, `month precision needs the first of the month (YYYY-MM-01), not ${ev.event_date}`);
    if (precision === "year" && !ev.event_date.endsWith("-01-01")) return err(at, `year precision needs YYYY-01-01, not ${ev.event_date}`);
    const q = quote(ev.quote, `${at}.quote`);
    if (q && precision === "day" && !stated(q.text, ev.event_date)) err(at, `event_date ${ev.event_date} is not stated in the quote`);
    const best = q && precision !== "day" ? mostPrecise(q.text, ev.event_date, precision) : null;
    if (q && precision !== "day" && best === null) err(at, `the quote does not state a ${precision} date ${ev.event_date} as a month and year or a year`);
    else if (best !== null && best !== precision) err(at, `the quote states a more precise ${best} date inside ${ev.event_date}: store the most precise date the quote states, not ${precision} precision`);
    if (ev.mode !== undefined && !LEG_MODE_CODES.includes(ev.mode as string)) err(at, `mode ${JSON.stringify(ev.mode)} is not a leg-mode token`);
    const ids = (Array.isArray(ev.entity_ids) ? ev.entity_ids : []).flatMap((id, k) => entityOf(id, `${at}.entity_ids[${k}]`) ?? []);
    if (q) plan.events.push({ event_kind: ev.event_kind as string, event_date: ev.event_date, date_precision: precision, quote: q, mode: typeof ev.mode === "string" ? ev.mode : null, entity_ids: ids });
  });
  if (entry.document_date !== undefined) {
    const d = entry.document_date;
    const q = isObj(d) && d.quote !== undefined ? quote(d.quote, "document_date.quote") : null;
    if (!isObj(d) || !isoDate(d.date) || d.quote === undefined) err("document_date", "must be { date (ISO), quote }: a document date without a quote is refused");
    else if (q && !stated(q.text, d.date)) err("document_date", `${d.date} is not stated in the quote`);
    else if (q) plan.document_date = { date: d.date, quote: q };
  }
  return { errors, plan: errors.length ? null : plan };
}
