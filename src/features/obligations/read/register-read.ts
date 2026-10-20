// Ported from old_repo/src/lib/obligations/read-register.mjs (lines 6-171)
// Ported from old_repo/src/lib/obligations/read-register.mjs (lines 272-489)
// The obligation register read, ONE paged path for the list and the detail variant. Every filter is applied in the query and the total is a database count
// over exactly those filters (INV-221): three exact counts (upcoming soonest first, past most recent first, undated by id) plan the page across the segments.
// The verified, live item is joined IN THE QUERY (an inner embed), so the count, the page and the item can never disagree (the old page was cut after the
// join and its total was not); a failed read throws (the route answers 503), it is never an empty page with a non-zero total.
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { canonicalJurisdictionCode, GENERIC_JURISDICTIONS } from "@/core/entities/id";
import { isValid } from "@/core/contracts/vocabularies";
import { qb, type Qb } from "@/core/db";
import { notInList, suppressedEventIds } from "@/core/derived/suppressed-events";

import { countOf, rowsOf } from "./qb";
import { fetchRegisterFacetOptions, type RegisterFacets } from "./register-facets";

const UNCLASSIFIED = "unclassified";
export const DUE_WINDOWS = ["overdue", "30", "90", "365", "undated", "all"] as const;
export type DueWindow = (typeof DUE_WINDOWS)[number];
const OBLIGATION_TEXT_TRIM_LENGTH = 160;
const ITEM_EMBED = "item:intelligence_items!inner(id, title, legacy_id, jurisdiction_iso)";
const REGISTER_SELECT = `id, intelligence_item_id, forward_event_id, jurisdiction, modes, binding_position, due_date, date_precision, event_kind, status, item_forward_events(obligation_text), ${ITEM_EMBED}`;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RegisterSpec {
  jurisdiction: string | null;
  mode: string | null;
  bindingPosition: string | null;
  dueWindow: DueWindow;
  limit: number;
  offset: number;
  todayIso: string;
  itemId: string | null;
}
export interface SpecInput {
  jurisdiction?: unknown;
  mode?: unknown;
  bindingPosition?: unknown;
  dueWindow?: unknown;
  limit?: unknown;
  offset?: unknown;
  todayIso?: unknown;
  itemId?: string | null;
}
/** The query spec from request input. `todayIso` is required in effect: the caller passes the render date (no wall clock here). */
export function buildRegisterQuerySpec(opts: SpecInput, todayIso: string): RegisterSpec {
  const j = typeof opts.jurisdiction === "string" && opts.jurisdiction.trim() ? canonicalJurisdictionCode(opts.jurisdiction) : null;
  const jurisdiction = j && !GENERIC_JURISDICTIONS.has(j.toLowerCase()) ? j.toLowerCase() : null;
  const mode = typeof opts.mode === "string" && opts.mode.trim() ? opts.mode.trim().toLowerCase() : null;
  const bp = opts.bindingPosition;
  const bindingPosition = typeof bp === "string" && (isValid("binding_position", bp) || bp === UNCLASSIFIED) ? bp : null;
  const dueWindow = (DUE_WINDOWS as readonly unknown[]).includes(opts.dueWindow) ? (opts.dueWindow as DueWindow) : "all";
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(500, Math.floor(opts.limit)) : 200;
  const offset = typeof opts.offset === "number" && Number.isFinite(opts.offset) && opts.offset >= 0 ? Math.floor(opts.offset) : 0;
  const today = typeof opts.todayIso === "string" && ISO_RE.test(opts.todayIso) ? opts.todayIso : todayIso;
  return { jurisdiction, mode, bindingPosition, dueWindow, limit, offset, todayIso: today, itemId: opts.itemId ?? null };
}

/** 0 upcoming (soonest first), 1 past (most recent first), 2 undated (by id). */
const nextDueSegment = (dueDate: string | null | undefined, todayIso: string): 0 | 1 | 2 => (dueDate === null || dueDate === undefined ? 2 : dueDate < todayIso ? 1 : 0);

/** Which slices of which segments a page covers, given each segment's exact size. */
function planRegisterPageSegments(sizes: readonly number[], offset: number, limit: number): { index: number; from: number; to: number }[] {
  const out: { index: number; from: number; to: number }[] = [];
  let skip = Math.max(0, Math.floor(offset) || 0);
  let remaining = Math.max(0, Math.floor(limit) || 0);
  for (let i = 0; i < sizes.length && remaining > 0; i += 1) {
    const n = Math.max(0, Math.floor(sizes[i] as number) || 0);
    if (skip >= n) {
      skip -= n;
      continue;
    }
    const take = Math.min(n - skip, remaining);
    out.push({ index: i, from: skip, to: skip + take - 1 });
    remaining -= take;
    skip = 0;
  }
  return out;
}

/** The obligation text bounded at READ to 160 characters (never at the write, REG-GRAIN). */
function trimObligationText(text: unknown, max = OBLIGATION_TEXT_TRIM_LENGTH): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

export interface RegisterItem {
  id: string;
  title: string | null;
  legacy_id: string | null;
  jurisdiction_iso: string[] | null;
}
export interface RegisterRow {
  id: string;
  intelligence_item_id: string;
  forward_event_id: string;
  jurisdiction: string[];
  modes: string[];
  binding_position: string | null;
  due_date: string | null;
  date_precision: string | null;
  event_kind: string;
  status: string;
  obligation_text: string | null;
  item: RegisterItem;
}
type Raw = Omit<RegisterRow, "obligation_text"> & { item_forward_events?: { obligation_text?: string | null } | { obligation_text?: string | null }[] | null };

function flatten(row: Raw): RegisterRow {
  const { item_forward_events: nested, ...rest } = row;
  const one = Array.isArray(nested) ? nested[0] : nested;
  return { ...rest, obligation_text: trimObligationText(one?.obligation_text) };
}

/** Jurisdiction codes present in the data that equal the filter or sit under it (`GB` matches `GB` and `GB-ENG`). */
function matchingJurisdictionCodes(codes: readonly string[], jurisdiction: string | null): string[] {
  if (!jurisdiction) return [];
  const needle = jurisdiction.toLowerCase();
  return codes.filter((c) => {
    const lc = String(c).toLowerCase();
    return lc === needle || lc.startsWith(`${needle}-`);
  });
}

const addDays = (iso: string, days: number): string => new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Every register filter as a query predicate (status active, the item join gate, jurisdiction, mode, binding position, due window). */
function applyRegisterFilters(q: Qb, spec: RegisterSpec, jurisdictionCodes: readonly string[] | null, suppressedEvents: string | null = null): Qb {
  let b = admitItems(q.eq("status", "active"), "item");
  if (suppressedEvents) b = b.not("forward_event_id", "in", suppressedEvents);
  if (spec.itemId) b = b.eq("intelligence_item_id", spec.itemId);
  if (jurisdictionCodes) b = b.overlaps("jurisdiction", jurisdictionCodes.length ? jurisdictionCodes : ["__no_match__"]);
  if (spec.mode) b = b.overlaps("modes", [spec.mode]);
  if (spec.bindingPosition) b = spec.bindingPosition === UNCLASSIFIED ? b.is("binding_position", null) : b.eq("binding_position", spec.bindingPosition);
  if (spec.dueWindow === "overdue") b = b.lt("due_date", spec.todayIso);
  else if (spec.dueWindow === "undated") b = b.is("due_date", null);
  else if (spec.dueWindow !== "all") {
    const days = Number(spec.dueWindow);
    if (Number.isFinite(days)) b = b.gte("due_date", spec.todayIso).lte("due_date", addDays(spec.todayIso, days));
  }
  return b;
}

const SEGMENTS: readonly { key: string; ascending: boolean; narrow: (q: Qb, spec: RegisterSpec) => Qb }[] = [
  { key: "upcoming", ascending: true, narrow: (q, s) => q.gte("due_date", s.todayIso) },
  { key: "past", ascending: false, narrow: (q, s) => q.lt("due_date", s.todayIso) },
  { key: "undated", ascending: true, narrow: (q) => q.is("due_date", null) },
];

/**
 * One page of the register in next-due order, with the exact total. `facets` (the corpus-wide facet read) is passed in when the caller already has it so a
 * jurisdiction filter does not re-read it. Any failed read or count throws.
 */
export async function fetchObligationRegisterPage(sb: Db, spec: RegisterSpec, opts: { facets?: RegisterFacets } = {}): Promise<{ rows: RegisterRow[]; total: number }> {
  let jurisdictionCodes: string[] | null = null;
  if (spec.jurisdiction) jurisdictionCodes = matchingJurisdictionCodes((opts.facets ?? (await fetchRegisterFacetOptions(sb, spec.todayIso))).jurisdictions, spec.jurisdiction);
  const suppressed = notInList(await suppressedEventIds(sb));
  const sizes: number[] = [];
  for (const seg of SEGMENTS) {
    const q = qb(sb.from("obligations").select(`id, ${ITEM_EMBED}`, { count: "exact", head: true }));
    sizes.push(countOf(`obligations ${seg.key}`, await seg.narrow(applyRegisterFilters(q, spec, jurisdictionCodes, suppressed), spec)));
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return { rows: [], total: 0 };
  const raw: Raw[] = [];
  for (const slice of planRegisterPageSegments(sizes, spec.offset, spec.limit)) {
    const seg = SEGMENTS[slice.index] as (typeof SEGMENTS)[number];
    const q = qb(sb.from("obligations").select(REGISTER_SELECT));
    const res = await seg.narrow(applyRegisterFilters(q, spec, jurisdictionCodes, suppressed), spec).order("due_date", { ascending: seg.ascending }).order("id", { ascending: true }).range(slice.from, slice.to);
    raw.push(...rowsOf<Raw>(`obligations ${seg.key} page`, res));
  }
  return { rows: raw.map(flatten), total };
}

/** The next-due comparator for rows already in memory (used by tests and by callers merging pages). */
function compareByNextDue(a: Pick<RegisterRow, "id" | "due_date">, b: Pick<RegisterRow, "id" | "due_date">, todayIso: string): number {
  const sa = nextDueSegment(a.due_date, todayIso);
  const sb = nextDueSegment(b.due_date, todayIso);
  if (sa !== sb) return sa - sb;
  if (sa === 2 || a.due_date === b.due_date) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return sa === 0 ? ((a.due_date as string) < (b.due_date as string) ? -1 : 1) : (a.due_date as string) > (b.due_date as string) ? -1 : 1;
}
