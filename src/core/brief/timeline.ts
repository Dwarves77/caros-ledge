// Ported from old_repo/src/lib/agent/timeline-harvest.mjs (lines 1-139)
// Ported from old_repo/src/lib/agent/timeline-parse.mjs (lines 1-114)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 17-76)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 82-145)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 151-242)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 257-267)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 273-314)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 330-351)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 365-385)
// Ported from old_repo/src/lib/agent/timeline-backfill-derive.mjs (lines 420-494)
// Ported from old_repo/src/lib/agent/derived-consistency.mjs (lines 1-47)
// Dates: the normaliser with its precision, the section parser, the row builder, the harvest, the eight-step derivation for an
// undated item (ADR-030: no item without a date) and the annual-rule consistency check. The month table is in vocab.ts, once.
import { findTimelineSection, specForItemType } from "./sections";
import { MONTH_NAMES, MONTHS, MONTHS_ANY_RE } from "./vocab";

export interface Normalised { iso: string; precision: string }
export interface TimelineEntry { date: string; label: string; source: string | null }
/** `date_precision` is how exact `milestone_date` is (a period start is sort order only): the readers show a year or a month for it and never a day (0094). */
export interface TimelineRow { milestone_date: string; date_precision: string; label: string; is_completed: boolean; sort_order: number }

/** The precisions whose date is a real day: a due-date count may be drawn from them and from no other. */
const EXACT_DAY = new Set(["day", "qualified"]);
const isExactDay = (precision: string | null | undefined): boolean => EXACT_DAY.has(String(precision));
/** The date text a reader hands a row: the whole day for an exact one, the month for a month, the year for anything coarser (a quarter, a half, "early 2027", a range): never a day that was not stated. */
export function timelineDateOf(milestoneDate: string, precision: string | null | undefined): string {
  if (isExactDay(precision)) return milestoneDate;
  return precision === "month" ? milestoneDate.slice(0, 7) : milestoneDate.slice(0, 4);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const validDay = (y: number, m: number, d: number): boolean => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const month = (name: string | undefined): number | undefined => MONTHS[(name ?? "").toLowerCase()];
const num = (s: string | undefined): number => Number(s);
const day = (y: number, m: number, d: number): Normalised | null => (validDay(y, m, d) ? { iso: iso(y, m, d), precision: "day" } : null);

/** One date-ish token to an ISO date plus its precision (day | month | quarter | half | year | range | qualified | segment), or null. */
function toIsoDate(token: string | null | undefined): Normalised | null {
  if (!token || typeof token !== "string") return null;
  let t = token.trim();
  const range = t.split(/\s+(?:to|–|—|through)\s+/i);
  if (range.length > 1) {
    const first = toIsoDate(range[0]);
    return first ? { iso: first.iso, precision: "range" } : null;
  }
  t = t.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1").replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  const qual = /^(?:by|from|until|before|after|effective|starting|beginning|end of|deadline)\s+(.+)$/i.exec(t);
  if (qual) {
    const inner = toIsoDate(qual[1]);
    return inner ? { iso: inner.iso, precision: inner.precision === "day" ? "qualified" : inner.precision } : null;
  }
  let m = /^(early|mid|late)[\s-]+(\d{4})$/i.exec(t);
  if (m) {
    const y = num(m[2]);
    return y >= 1990 && y <= 2100 ? { iso: iso(y, { early: 1, mid: 6, late: 10 }[(m[1] ?? "").toLowerCase()] ?? 1, 1), precision: "segment" } : null;
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) return day(num(m[1]), num(m[2]), num(m[3]));
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(t))) return num(m[2]) >= 1 && num(m[2]) <= 12 ? { iso: iso(num(m[1]), num(m[2]), 1), precision: "month" } : null;
  if ((m = /^q([1-4])\s+(\d{4})$/i.exec(t))) return { iso: iso(num(m[2]), (num(m[1]) - 1) * 3 + 1, 1), precision: "quarter" };
  if ((m = /^h([12])\s+(\d{4})$/i.exec(t))) return { iso: iso(num(m[2]), m[1] === "1" ? 1 : 7, 1), precision: "half" };
  if ((m = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(t)) && month(m[2])) return day(num(m[3]), month(m[2]) as number, num(m[1]));
  if ((m = /^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/i.exec(t)) && month(m[1])) return day(num(m[3]), month(m[1]) as number, num(m[2]));
  if ((m = /^([a-z]+)\s+(\d{4})$/i.exec(t)) && month(m[1])) return { iso: iso(num(m[2]), month(m[1]) as number, 1), precision: "month" };
  if ((m = /^(\d{4})$/.exec(t))) return num(m[1]) >= 1990 && num(m[1]) <= 2100 ? { iso: iso(num(m[1]), 1, 1), precision: "year" } : null;
  return null;
}

/**
 * item_timelines rows from timeline entries: a day-precise date is exact and the label clean; any other precision keeps the original
 * token IN the label (the date is the period start, sort order only, never a fabricated day). Unparseable tokens come back in
 * `skipped`, never silently. Sorted chronologically, deduped on (date, label); is_completed = date before `todayIso`.
 */
export function buildTimelineRows(entries: TimelineEntry[] | null | undefined, todayIso: string): { rows: TimelineRow[]; skipped: { date: string; label: string; reason: string }[] } {
  const skipped: { date: string; label: string; reason: string }[] = [];
  const parsed: { milestone_date: string; date_precision: string; label: string }[] = [];
  for (const e of entries ?? []) {
    if (!e?.label?.trim()) {
      skipped.push({ date: e?.date ?? "", label: e?.label ?? "", reason: "empty label" });
      continue;
    }
    const norm = toIsoDate(e.date);
    if (!norm) {
      skipped.push({ date: e.date, label: e.label, reason: "unparseable date token" });
      continue;
    }
    const base = e.source ? `${e.label.trim()} (${e.source.trim()})` : e.label.trim();
    parsed.push({ milestone_date: norm.iso, date_precision: norm.precision, label: (norm.precision === "day" ? base : `${e.date.trim()} — ${base}`).slice(0, 500) });
  }
  parsed.sort((a, b) => (a.milestone_date < b.milestone_date ? -1 : a.milestone_date > b.milestone_date ? 1 : 0));
  const seen = new Set<string>();
  const rows: TimelineRow[] = [];
  for (const p of parsed) {
    const key = `${p.milestone_date}|${p.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...p, is_completed: p.milestone_date < todayIso, sort_order: rows.length });
  }
  return { rows, skipped };
}

const DATE_FORM =
  `\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS_ANY_RE})\\.?\\s+\\d{4}|(?:${MONTHS_ANY_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|(?:${MONTHS_ANY_RE})\\.?\\s+\\d{4}|[Qq][1-4]\\s+\\d{4}|[Hh][12]\\s+\\d{4}|\\d{4}`;
const DATE_TOKEN_RE = new RegExp(`^(?:${DATE_FORM})(?:\\s*(?:to|–|—)\\s*(?:${DATE_FORM}))?`, "i");

/** The first standalone `:` or spaced dash splits a leading qualifier from the label; a mid-word hyphen never does. */
function splitAtSeparator(text: string): { qualifier: string; rest: string } | null {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ":") return { qualifier: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
    if (c === "-" || c === "–" || c === "—") {
      const before = i === 0 ? " " : text[i - 1];
      const after = i === text.length - 1 ? " " : text[i + 1];
      if (before === " " && after === " ") return { qualifier: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

/** Section timeline entries in both shapes: bulleted lines opening with a date token, and `| date | milestone | ... |` table rows. */
export function parseTimeline(markdown: string | null | undefined): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const raw of String(markdown ?? "").split(/\n+/)) {
    const trimmed = raw.trim();
    if (!trimmed || /^[-*_]{3,}$/.test(trimmed)) continue;
    if (trimmed.startsWith("|")) {
      const cells = trimmed.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""));
      if (cells.length < 2 || cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const date = (cells[0] ?? "").replace(/\*\*/g, "").trim();
      const label = (cells[1] ?? "").replace(/\*\*/g, "").trim();
      if (date && label && !/^date\b/i.test(date)) entries.push({ date, label, source: null });
      continue;
    }
    const stripped = trimmed.replace(/^[-*+]\s+/, "");
    const dm = DATE_TOKEN_RE.exec(stripped);
    const split = dm ? splitAtSeparator(stripped.slice(dm[0].length)) : null;
    if (!dm || !split) continue;
    let rest = split.rest;
    let source: string | null = null;
    const paren = /\s*\(source:\s*([^)]+)\)\s*$/i.exec(rest);
    const trailing = paren ? null : /\s+(?:source|src)\s*[:\-]\s*(.+)$/i.exec(rest);
    const src = paren ?? trailing;
    if (src) {
      source = (src[1] ?? "").trim();
      rest = rest.slice(0, src.index).trim();
    }
    const label = split.qualifier ? `${split.qualifier}: ${rest}` : rest;
    if (label) entries.push({ date: dm[0].trim(), label, source });
  }
  return entries;
}

/** The brief's timeline section to rows; `applicable` is false when the item type has no mapped timeline section. */
export function harvestTimeline(fullBrief: string | null | undefined, itemType: string | null | undefined, todayIso: string): { applicable: boolean; rows: TimelineRow[]; skipped: { date: string; label: string; reason: string }[] } {
  const spec = specForItemType(itemType);
  const section = spec ? findTimelineSection(fullBrief ?? "", spec.formatType) : null;
  if (!spec || !spec.sections.some((s) => s.roles?.includes("timeline"))) return { applicable: false, rows: [], skipped: [] };
  return { applicable: true, ...buildTimelineRows(section ? parseTimeline(section.contentMarkdown) : [], todayIso) };
}

// ---- the eight-step derivation for an undated item -------------------------------------------------------

export interface Derived { token: string; iso: string; precision: string; baseLabel: string; source: string; form?: string }
export interface DeriveInput {
  title?: string | null; sourceUrl?: string | null; capturedText?: string | null; identifier?: string | null;
  forwardEvents?: { event_date: string; date_precision?: string; event_kind?: string; obligation_text?: string }[] | null;
  bestCapture?: { searched_at?: string | null } | null; createdAt?: string | null;
}
type Hit = { token: string; iso: string; precision: string };

const hit = (token: string, text: string | undefined): Hit | null => {
  const n = toIsoDate(text ?? token);
  return n ? { token, iso: n.iso, precision: n.precision } : null;
};
const TITLE_DOT = /\bof\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\b/i;
const TITLE_OF = /\bof\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\.?\s+\d{4})\b/i;
const TITLE_BARE = /\b(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\.?\s+\d{4})\b/i;
/** Step 2: the instrument's own date in its title; the FIRST match, so an amending title's date wins over a cited instrument's. */
function extractTitleDate(title: string | null | undefined): Hit | null {
  if (!title) return null;
  const dot = TITLE_DOT.exec(title);
  const fromDot = dot ? hit(`${dot[1]}.${dot[2]}.${dot[3]}`, `${dot[3]}-${(dot[2] ?? "").padStart(2, "0")}-${(dot[1] ?? "").padStart(2, "0")}`) : null;
  const of = TITLE_OF.exec(title);
  const bare = TITLE_BARE.exec(title);
  return fromDot ?? (of ? hit(of[1] ?? "", of[1]) : null) ?? (bare ? hit(bare[1] ?? "", bare[1]) : null);
}
/** Step 3: a Federal Register document URL's own /documents/YYYY/MM/DD/ segment. */
function extractFederalRegisterDate(sourceUrl: string | null | undefined): Hit | null {
  const m = /federalregister\.gov\/documents\/(\d{4})\/(\d{2})\/(\d{2})\//i.exec(sourceUrl ?? "");
  return m ? hit(`${m[1]}-${m[2]}-${m[3]}`, `${m[1]}-${m[2]}-${m[3]}`) : null;
}
const UK_BOUNDARY = /^\s*(?:part\s+1\b|1\.\s)|\bregulation\s+1\b|\bsection\s+1\b/im;
const UK_MAX = 1500;
/** The item's OWN front matter: from its title when locatable, to the first substantive-body marker or a fixed ceiling. */
function ukFrontMatterWindow(fullText: string, title: string | null | undefined): string {
  const idx = title?.trim() ? fullText.toLowerCase().indexOf(title.trim().toLowerCase()) : -1;
  const rest = fullText.slice(Math.max(0, idx));
  const b = UK_BOUNDARY.exec(rest);
  return rest.slice(0, Math.min(b ? b.index : UK_MAX, UK_MAX));
}
/** Step 4: legislation.gov.uk Made line, Royal Assent bracket, then a year-only identifier fallback; bounded to the front matter. */
function extractLegislationGovUkDate(input: { capturedText?: string | null | undefined; identifier?: string | null | undefined; title?: string | null | undefined }): (Hit & { baseLabel: string; form: string }) | null {
  const text = ukFrontMatterWindow(input.capturedText ?? "", input.title);
  const made = /\bMade\b[^\n]{0,40}?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})\b/i.exec(text);
  const assent = /\[(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})\]/.exec(text);
  const idYear = /\b(?:uk\w*|asp|wsi|ssi|nia|mnia)\b.*?(\d{4})\/\d+/i.exec(input.identifier ?? "");
  const tries: [RegExpExecArray | null, string, string][] = [[made, "Made (legislation.gov.uk)", "made"], [assent, "Royal Assent (legislation.gov.uk)", "royal_assent"], [idYear, "Enacted (legislation.gov.uk identifier year)", "identifier_year"]];
  for (const [m, baseLabel, form] of tries) {
    const h = m ? hit(m[1] ?? "", m[1]) : null;
    if (h) return { ...h, baseLabel, form };
  }
  return null;
}
const compact = (eventDate: string, precision: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate);
  if (!m) return eventDate;
  const name = (MONTH_NAMES[parseInt(m[2] ?? "0", 10) - 1] ?? "").slice(0, 3);
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return precision === "year" ? (m[1] ?? "") : precision === "month" ? `${cap} ${m[1]}` : `${cap} ${parseInt(m[3] ?? "0", 10)} ${m[1]}`;
};
/** Step 5: the earliest forward event, labeled from its obligation text prefixed by its kind. */
function extractForwardEventDate(events: DeriveInput["forwardEvents"]): (Hit & { baseLabel: string }) | null {
  const list = (events ?? []).filter((e) => e && typeof e.event_date === "string" && e.event_date);
  const earliest = [...list].sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0))[0];
  if (!earliest) return null;
  const precision = earliest.date_precision === "month" || earliest.date_precision === "year" ? earliest.date_precision : "day";
  const kind = String(earliest.event_kind ?? "event").replace(/_/g, " ");
  const obligation = String(earliest.obligation_text ?? "").trim();
  return { token: compact(earliest.event_date, precision), iso: earliest.event_date, precision, baseLabel: obligation ? `${kind}: ${obligation}` : kind };
}
const PUBLISHED_LABEL = "Published (from the source page)";
/**
 * Step 6: a date the page introduces with a publication marker (Published, Dated, Issued) or a <time datetime> tag is labelled Published. A bare "D Month YYYY" in the first 400 characters is any date
 * (an amended instrument's, an entry into force, a cited item's): it is used when nothing better exists and says only that it was found on the page (F:13).
 */
function extractDatelineDate(capturedText: string | null | undefined): (Hit & { baseLabel: string }) | null {
  if (!capturedText) return null;
  const w = capturedText.slice(0, 400);
  const marked = /\b(?:Published|Dated|Issued)(?:\s+on)?\s*:?\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})\b/i.exec(w);
  const bare = /\b(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})\b/i.exec(w);
  const tag = /<time\b[^>]*\bdatetime=["']([^"']+)["'][^>]*>/i.exec(capturedText);
  const dt = tag ? /^(\d{4}-\d{2}-\d{2})/.exec(tag[1] ?? "")?.[1] : undefined;
  const found = (h: Hit | null, baseLabel: string) => (h ? { ...h, baseLabel } : null);
  return found(marked ? hit(marked[1] ?? "", marked[1]) : null, PUBLISHED_LABEL) ?? found(dt ? hit(dt, dt) : null, PUBLISHED_LABEL) ?? found(bare ? hit(bare[1] ?? "", bare[1]) : null, "Date found on the source page");
}
const dayOf = (ts: string | null | undefined): Hit | null => {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(ts ?? "")?.[1];
  return d ? hit(d, d) : null;
};
const CAPTURED_FALLBACK_SORT_ORDER = 999;
const RECORDED_FALLBACK_SORT_ORDER = 1000;
/** The sort order the title-derived captured and recorded fallbacks take (below): they say when the pipeline saw the item, not when the instrument was dated, so no reader shows them as a milestone. */
export const isInstrumentMilestone = (sortOrder: number | null | undefined): boolean => (sortOrder ?? 0) < CAPTURED_FALLBACK_SORT_ORDER;
const containsCi = (text: string | null | undefined, token: string | null | undefined): boolean => !!text && !!token && text.toLowerCase().includes(token.toLowerCase());

/**
 * First hit wins: title (verified against the capture), Federal Register path, legislation.gov.uk, earliest forward event,
 * dateline, then the captured-date and recorded-in-ledger fallbacks, labeled as such and sorted last. Every attempt is named in
 * `attempts` for the audit trail. Pure.
 */
export function deriveTimeline(input: DeriveInput): { result: Derived | null; attempts: { step: string; outcome: string; token?: string; form?: string }[] } {
  const attempts: { step: string; outcome: string; token?: string; form?: string }[] = [];
  const done = (step: string, h: Hit & { baseLabel?: string; form?: string }, baseLabel: string): { result: Derived; attempts: typeof attempts } => {
    attempts.push({ step, outcome: "hit", token: h.token, ...(h.form ? { form: h.form } : {}) });
    return { result: { token: h.token, iso: h.iso, precision: h.precision, baseLabel, source: step, ...(h.form ? { form: h.form } : {}) }, attempts };
  };
  const title = extractTitleDate(input.title);
  if (title && containsCi(input.capturedText, title.token)) return done("title", title, "Adopted (from the instrument title)");
  attempts.push(title ? { step: "title", outcome: "miss-not-in-capture", token: title.token } : { step: "title", outcome: "no-token-in-title" });
  const fr = extractFederalRegisterDate(input.sourceUrl);
  if (fr) return done("federal_register", fr, "Published in the Federal Register");
  attempts.push({ step: "federal_register", outcome: "no-match" });
  const leg = extractLegislationGovUkDate({ capturedText: input.capturedText, identifier: input.identifier, title: input.title });
  if (leg) return done("legislation_gov_uk", leg, leg.baseLabel);
  attempts.push({ step: "legislation_gov_uk", outcome: "no-match" });
  const fe = extractForwardEventDate(input.forwardEvents);
  if (fe) return done("forward_event", fe, fe.baseLabel);
  attempts.push({ step: "forward_event", outcome: "no-events" });
  const dl = extractDatelineDate(input.capturedText);
  if (dl) return done("dateline", dl, dl.baseLabel);
  attempts.push({ step: "dateline", outcome: "no-match" });
  const cap = dayOf(input.bestCapture?.searched_at);
  if (cap) return done("captured", cap, "Captured (source page retrieved on this date; not the instrument's own date)");
  attempts.push({ step: "captured", outcome: "no-searched-at" });
  const rec = dayOf(input.createdAt);
  if (rec) return done("recorded", rec, "Recorded in the ledger on this date; not the instrument's own date");
  attempts.push({ step: "recorded", outcome: "no-created-at" });
  return { result: null, attempts };
}
/** A derivation as the item_timelines row (the precision-honest label), the captured and recorded fallbacks sorting last. */
export function derivedTimelineRow(d: Derived, todayIso: string): TimelineRow {
  const label = (d.precision === "day" ? d.baseLabel : `${d.token} - ${d.baseLabel}`).slice(0, 500);
  return { milestone_date: d.iso, date_precision: d.precision, label, is_completed: d.iso < todayIso, sort_order: d.source === "recorded" ? RECORDED_FALLBACK_SORT_ORDER : d.source === "captured" ? CAPTURED_FALLBACK_SORT_ORDER : 0 };
}

// ---- Gate B: annual-rule consistency of a derived date --------------------------------------------------------
const MON = `(${MONTH_NAMES.join("|")})`;
/** A recurring annual rule in a FACT span (an annual signal AND a month, day optional), or null. */
function parseRecurringRule(span: string | null | undefined): { kind: "annual"; month: number; day: number | null } | null {
  const s = String(span ?? "").toLowerCase();
  if (!/\b(every year|each year|annually|annual|yearly|per year|per annum|each calendar year)\b/.test(s)) return null;
  const a = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s);
  if (a) return { kind: "annual", month: MONTHS[a[1] ?? ""] as number, day: parseInt(a[2] ?? "0", 10) };
  const b = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\b`).exec(s);
  if (b) return { kind: "annual", month: MONTHS[b[2] ?? ""] as number, day: parseInt(b[1] ?? "0", 10) };
  const c = new RegExp(`\\b${MON}\\b`).exec(s);
  return c ? { kind: "annual", month: MONTHS[c[1] ?? ""] as number, day: null } : null;
}
/** A derived-date token to { year, month|null, day|null }, or null. */
function parseDerivedDate(token: string | null | undefined): { year: number; month: number | null; day: number | null } | null {
  const t = String(token ?? "").trim().toLowerCase();
  let m = new RegExp(`^(\\d{1,2})\\s+${MON}\\s+(\\d{4})$`).exec(t);
  if (m) return { day: parseInt(m[1] ?? "0", 10), month: MONTHS[m[2] ?? ""] as number, year: parseInt(m[3] ?? "0", 10) };
  if ((m = new RegExp(`^${MON}\\s+(\\d{4})$`).exec(t))) return { day: null, month: MONTHS[m[1] ?? ""] as number, year: parseInt(m[2] ?? "0", 10) };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) return { year: parseInt(m[1] ?? "0", 10), month: parseInt(m[2] ?? "0", 10), day: parseInt(m[3] ?? "0", 10) };
  return (m = /^(19[89]\d|20[0-4]\d)$/.exec(t)) ? { year: parseInt(m[1] ?? "0", 10), month: null, day: null } : null;
}
/** Is the derived date arithmetically consistent with the recurring rule? Fail closed on any mismatch or unparseable input. */
export function isDerivedConsistent(ruleSpan: string | null | undefined, token: string | null | undefined): boolean {
  const rule = parseRecurringRule(ruleSpan);
  const date = parseDerivedDate(token);
  if (!rule || !date || date.year < 1990 || date.year > 2049) return false;
  if (date.month != null && date.month !== rule.month) return false;
  return !(date.day != null && rule.day != null && date.day !== rule.day);
}
