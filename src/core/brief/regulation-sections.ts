// Ported from old_repo/src/lib/agent/extract-regulation-sections.ts (lines 1-492)
// Ported from old_repo/src/lib/agent/extract-recommended-actions.mjs (lines 1-148)
// Ported from old_repo/src/lib/agent/parse-record-sections.ts (lines 1-189)
// Ported from old_repo/src/lib/agent/source-entry-filter.mjs (lines 1-38)
// The structured parsers the detail surfaces read (P2-10 imports them from here): the seven regulation sections, the record-grade
// claim lines, the "do now" recommended actions, and the placeholder-name filter (the F-1 header-echo class).
import { extractSectionByHeading, sectionWithRole, specForItemType } from "./sections";
import { parseTimeline, type TimelineEntry } from "./timeline";

export type RegulationSectionKey = "3" | "4" | "8" | "10" | "11" | "14" | "15";
export type Severity = "action_required" | "cost_alert" | "window_closing" | "competitive_edge" | "monitoring";
export interface ActionListItem { severity: Severity | null; label: string; body: string }
export interface ObligationRow { obligation: string; deadline: string; status: string; nextAction: string }
export interface SourceEntry { tier: number | null; name: string; meta: string; url: string | null }
export type RegulationSection =
  | { kind: "action_list"; heading: string; items: ActionListItem[] }
  | { kind: "prose_with_source"; heading: string; markdown: string; source: string | null }
  | { kind: "obligations_table"; heading: string; rows: ObligationRow[] }
  | { kind: "prose"; heading: string; markdown: string }
  | { kind: "timeline"; heading: string; entries: TimelineEntry[] }
  | { kind: "sources_list"; heading: string; entries: SourceEntry[] };

const HEADINGS: Record<RegulationSectionKey, string[]> = {
  "3": ["Issues Requiring Immediate Action", "§3 Issues Requiring Immediate Action"],
  "4": ["How the Workspace Sits in the Compliance Chain", "§4 How the Workspace Sits in the Compliance Chain"],
  "8": ["Substantive Requirements", "§8 Substantive Requirements"],
  "10": ["Registration and Reporting Obligations", "§10 Registration and Reporting Obligations"],
  "11": ["Operational System Requirements", "§11 Operational System Requirements"],
  "14": ["Confirmed Regulatory Timeline", "§14 Confirmed Regulatory Timeline"],
  "15": ["Sources", "§15 Sources"],
};

const HEADER_LITERALS = new Set([
  "source name", "source", "name", "title", "#", "no", "url", "link", "tier", "tier estimate", "type", "issuing body", "body", "date", "why this source matters", "why", "notes", "note", "description",
  "obligation", "deadline", "status", "next action", "requirement", "event", "milestone", "phase", "trigger", "action", "severity", "when", "what",
]);
const NO_DATA = new Set(["", "—", "–", "-", "n/a", "na", "tbd", "tba", "...", "…", "null", "none"]);
/** True when a parsed field is not real: null, empty, a no-data token, a table-header literal or a separator fragment. */
export function isPlaceholderSourceName(name: string | null | undefined): boolean {
  if (name == null) return true;
  const t = String(name).trim().toLowerCase();
  return NO_DATA.has(t) || HEADER_LITERALS.has(t) || /^[|:\-–—\s]+$/.test(t);
}

const SEVERITY_KEY: Record<string, Severity> = { "action required": "action_required", "cost alert": "cost_alert", "window closing": "window_closing", "competitive edge": "competitive_edge", monitoring: "monitoring" };
const stripEmphasis = (s: string) => s.replace(/\*{2,}/g, "").replace(/^\*+|\*+$/g, "").trim();

/** Section 3 rows: bulleted paragraphs opening with a severity token and a label. */
function parseActionList(markdown: string): ActionListItem[] {
  const items: ActionListItem[] = [];
  for (const blk of markdown.split(/\n{2,}/)) {
    const t = blk.trim();
    if (!t || /^[-*_]{3,}$/.test(t)) continue;
    const inline = t.replace(/^[-*+]\s+/, "").replace(/^\*+\s*/, "");
    const sev = /^([A-Z][A-Z\s]+?)\*{0,2}\s*[-—:]\s*/.exec(inline);
    const key = sev ? SEVERITY_KEY[(sev[1] ?? "").trim().toLowerCase().replace(/\s+/g, " ")] : undefined;
    const rest = sev && key ? inline.slice(sev[0].length).trim() : inline;
    let label = "";
    let body = rest;
    const bold = /^\*\*([^*]+)\*\*\s*[:\-–—]?\s*/.exec(rest);
    const colon = rest.indexOf(":");
    const sentence = rest.search(/[.!?](?:\s|$)/);
    if (bold) {
      label = (bold[1] ?? "").trim();
      body = rest.slice(bold[0].length).trim();
    } else if (colon > 0 && colon < 80) {
      label = rest.slice(0, colon).trim();
      body = rest.slice(colon + 1).trim();
    } else if (sentence > 0 && sentence < 120) {
      label = rest.slice(0, sentence + 1).trim();
      body = rest.slice(sentence + 1).trim();
    } else {
      label = rest;
      body = "";
    }
    if (label || body || key) items.push({ severity: key ?? null, label: stripEmphasis(label), body: stripEmphasis(body) });
  }
  return items;
}

/** Section 4: prose followed (often) by a trailing "Source:" line or an italicised source citation. */
function parseProseWithSource(heading: string, markdown: string): RegulationSection {
  const lines = markdown.split(/\r?\n/);
  let source: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = (lines[i] ?? "").trim();
    if (!ln) continue;
    if (/^source\s*[:\-—]/i.test(ln)) source = ln.replace(/^source\s*[:\-—]\s*/i, "").trim();
    else if (/^[*_].+[*_]$/.test(ln) && /source/i.test(ln)) source = ln.replace(/^[*_]+|[*_]+$/g, "").trim();
    if (source !== null) lines.splice(i, 1);
    break;
  }
  return { kind: "prose_with_source", heading, markdown: lines.join("\n").trim(), source };
}

const SEPARATOR = /^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|$/;
/** Section 8: the first markdown table (header, separator, rows) as four-column obligation rows; short rows are padded. */
function parseObligationsTable(markdown: string): ObligationRow[] {
  const lines = markdown.split(/\r?\n/).map((l) => l.trim());
  const head = lines.findIndex((ln, i) => ln.startsWith("|") && SEPARATOR.test(lines[i + 1] ?? ""));
  if (head === -1) return [];
  const rows: ObligationRow[] = [];
  for (const ln of lines.slice(head + 2)) {
    if (!ln.startsWith("|")) break;
    const cells = ln.split("|").map((c) => c.trim()).filter((_, idx, arr) => idx !== 0 && idx !== arr.length - 1);
    if (cells.length < 2) continue;
    rows.push({ obligation: cells[0] ?? "", deadline: cells[1] ?? "", status: cells[2] ?? "", nextAction: cells[3] ?? "" });
  }
  return rows;
}

const URL_RE = /(https?:\/\/[^\s)]+)/i;
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/;
/**
 * Section 15: a table (every header row, not only the first, is skipped: a second "New Sources Identified" table once fabricated a
 * source named "Source Name", the F-1 defect) or, for live bodies written before the table shape, bulleted lines.
 */
function parseSourcesList(markdown: string): SourceEntry[] {
  const lines = markdown.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const table = lines.filter((l) => l.startsWith("|") && l.indexOf("|", 1) > 0);
  const entries: SourceEntry[] = [];
  if (table.length >= 2 && table.some((l) => TABLE_SEP.test(l))) {
    const headers = new Set(table.flatMap((l, i) => (!TABLE_SEP.test(l) && TABLE_SEP.test(table[i + 1] ?? "") ? [i] : [])));
    table.forEach((line, t) => {
      if (TABLE_SEP.test(line) || headers.has(t)) return;
      const cells = line.split("|").map((c) => c.trim()).filter((c, i, a) => !(c === "" && (i === 0 || i === a.length - 1)));
      const titleIdx = /^\d+$/.test(cells[0] ?? "") && cells.length > 1 ? 1 : 0;
      const name = cells[titleIdx] ?? "";
      if (!cells.length || isPlaceholderSourceName(name)) return;
      let urlIdx = -1;
      for (let i = cells.length - 1; i > titleIdx && urlIdx < 0; i--) if (URL_RE.test(cells[i] ?? "")) urlIdx = i;
      const tier = /(?:tier\s*|T)(\d)\b/i.exec(cells[titleIdx + 1] ?? "")?.[1];
      const meta = cells.slice(titleIdx + 1, urlIdx >= 0 ? urlIdx : cells.length).filter(Boolean).join(" · ");
      entries.push({ tier: tier ? parseInt(tier, 10) : null, name, meta, url: urlIdx >= 0 ? (URL_RE.exec(cells[urlIdx] ?? "")?.[1] ?? null) : null });
    });
    return entries;
  }
  for (const raw of lines) {
    if (/^[-*_]{3,}$/.test(raw)) continue;
    const stripped = raw.replace(/^[-*+]\s+/, "");
    const tm = /^[[(]?(?:tier\s*)?T?(\d)[\])]?\s*[-:—]?\s*/i.exec(stripped);
    const body = tm ? stripped.slice(tm[0].length).trim() : stripped;
    const bold = /^\*\*([^*]+)\*\*\s*[-—:.]?\s*/.exec(body);
    const split = body.search(/\s*[—–-]\s+/);
    const name = bold ? (bold[1] ?? "").trim() : split > 0 && split < 120 ? body.slice(0, split).trim() : body;
    const meta = bold ? body.slice(bold[0].length).trim() : split > 0 && split < 120 ? body.slice(split).replace(/^\s*[—–-]\s*/, "").trim() : "";
    if (name) entries.push({ tier: tm ? parseInt(tm[1] ?? "0", 10) : null, name, meta, url: URL_RE.exec(body)?.[1] ?? null });
  }
  return entries;
}

/** One section's markdown body parsed by its key. */
export function parseRegulationSection(key: RegulationSectionKey, heading: string, markdown: string): RegulationSection {
  switch (key) {
    case "3": return { kind: "action_list", heading, items: parseActionList(markdown) };
    case "4": return parseProseWithSource(heading, markdown);
    case "8": return { kind: "obligations_table", heading, rows: parseObligationsTable(markdown) };
    case "14": return { kind: "timeline", heading, entries: parseTimeline(markdown) };
    case "15": return { kind: "sources_list", heading, entries: parseSourcesList(markdown) };
    default: return { kind: "prose", heading, markdown: markdown.trim() };
  }
}

/** A `full_brief` to the seven structured sections; a missing section is omitted, a present one with no rows returns empty rows. */
export function parseRegulationSections(fullBrief: string | null | undefined): Partial<Record<RegulationSectionKey, RegulationSection>> {
  const result: Partial<Record<RegulationSectionKey, RegulationSection>> = {};
  if (!fullBrief) return result;
  for (const key of Object.keys(HEADINGS) as RegulationSectionKey[]) {
    for (const variant of HEADINGS[key]) {
      const got = extractSectionByHeading(fullBrief, variant);
      if (got) {
        result[key] = parseRegulationSection(key, got.heading, got.contentMarkdown);
        break;
      }
    }
  }
  return result;
}

// ---- recommended actions ---------------------------------------------------------------------------------
export const CONCRETE_ACTION_VERBS = ["Assess", "Map", "Verify", "Commission", "Engage", "Negotiate", "Reconcile"] as const;
const LEGISLATIVE_CITATION = /^Commission\s+(Implementing\s+|Delegated\s+)?(Regulation|Directive|Decision)\b/;
const COMMISSION_AS_INSTITUTION = /^Commission\s+(is|was|are|were|will|shall|has|have|had|must|should|would|may|might|can|could|plans?|scheduled|submits?|adopts?|publishes?|proposes?|issued?|announced?)\b/i;
const LABEL_MARKER = /\s*\*(Operational implication|Analytical inference|Industry interpretation|Legal Confirmation Required):\*/;
const TIMEFRAME = /\((\d+)\s*days?\)\s*\.?\s*$/i;
const EXPLICIT_DUE_DATE = /\b(?:by|before|no later than)\s+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/i;
const OWNER = /\(Owner:\s*([^)]+)\)/i;
export interface RecommendedAction { action_text: string; verb: string; timeframe_days: number | null; owner: string | null; due_date: string | null; source_section: string }

/** One action from a paragraph: a concrete verb first, the label marker ends the sentence; a due date ONLY when stated explicitly (rule 2). */
export function extractActionFromParagraph(paragraph: string, sourceSection: string): RecommendedAction | null {
  const stripped = paragraph.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "");
  const verb = new RegExp(`^(${CONCRETE_ACTION_VERBS.join("|")})\\b`).exec(stripped)?.[1];
  if (!verb || LEGISLATIVE_CITATION.test(stripped) || COMMISSION_AS_INSTITUTION.test(stripped)) return null;
  const split = LABEL_MARKER.exec(stripped);
  const text = (split ? stripped.slice(0, split.index) : stripped).trim();
  if (text.length < 10) return null;
  const due = EXPLICIT_DUE_DATE.exec(text)?.[1];
  const d = due ? new Date(due) : null;
  return {
    action_text: text,
    verb,
    timeframe_days: TIMEFRAME.exec(text) ? parseInt(TIMEFRAME.exec(text)?.[1] ?? "0", 10) : null,
    owner: OWNER.exec(text)?.[1]?.trim() ?? null,
    due_date: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null,
    source_section: sourceSection,
  };
}
/** Every structured action in the do_now sections of the item type's format (the section roles of the contract table). */
export function extractRecommendedActions(fullBrief: string | null | undefined, itemType: string | null | undefined): RecommendedAction[] {
  if (!fullBrief) return [];
  const out: RecommendedAction[] = [];
  for (const def of sectionWithRole(specForItemType(itemType)?.formatType ?? "", "do_now")) {
    const sec = extractSectionByHeading(fullBrief, def.heading);
    for (const p of (sec?.contentMarkdown ?? "").split(/\n{2,}/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)) {
      const a = extractActionFromParagraph(p, sec?.heading ?? def.heading);
      if (a) out.push(a);
    }
  }
  return out;
}

// ---- record-grade claim lines ----------------------------------------------------------------------------
export interface ClaimTierInfo { tier: number | null; sourceName: string | null; sourceUrl: string | null }
export interface RecordFactRow { slotKey: string; label: string; kind: "FACT" | "GAP"; text: string; span: string | null; rawLine: string; tier: number | null; sourceName: string | null; sourceUrl: string | null }
export interface ParsedRecordSections { facts: RecordFactRow[]; gaps: RecordFactRow[]; slotFieldCount: number; sourceUrl: string | null }
/** The sentence every record-grade GAP claim ends with; the writer (record-facts) and this reader share this one constant. */
export const GAP_MARKER = "A full-brief regrounding will re-examine this gap when this item upgrades from record to brief.";

/** One `[slot_key] sentence «span»` line; a GAP never looks up a tier (it has no source to rate). */
function parseClaimLine(line: string, claimTiers?: Record<string, ClaimTierInfo>): RecordFactRow | null {
  const trimmed = line.trim();
  const m = /^\[([a-z0-9_]+)\]\s*(.*)$/i.exec(trimmed);
  if (!m) return null;
  const slotKey = m[1] ?? "";
  const rest = m[2] ?? "";
  const gap = rest.includes(GAP_MARKER);
  const info = !gap && claimTiers ? (claimTiers[trimmed] ?? null) : null;
  const spans = [...rest.matchAll(/«([^»]*)»/g)];
  const spaced = slotKey.replace(/_/g, " ").trim();
  return { slotKey, label: spaced.charAt(0).toUpperCase() + spaced.slice(1), kind: gap ? "GAP" : "FACT", text: rest.trim(), span: gap ? null : (spans[spans.length - 1]?.[1] ?? null), rawLine: trimmed, tier: info?.tier ?? null, sourceName: info?.sourceName ?? null, sourceUrl: info?.sourceUrl ?? null };
}
const claimLines = (contentMd: string, tiers?: Record<string, ClaimTierInfo>): RecordFactRow[] =>
  String(contentMd ?? "").split(/\r?\n/).flatMap((raw) => parseClaimLine(raw.replace(/^-\s+/, ""), tiers) ?? []);

/** A record-grade item's section rows to render-ready facts and gaps; null when neither identity nor record_facts is present. */
export function parseRecordSections(rows: { section_key: string; content_md: string }[] | null | undefined, claimTiers?: Record<string, ClaimTierInfo>): ParsedRecordSections | null {
  const list = Array.isArray(rows) ? rows : [];
  const by = (k: string) => list.find((r) => r.section_key === k);
  if (!by("identity") && !by("record_facts")) return null;
  const slotRows = by("record_facts") ? claimLines(by("record_facts")?.content_md ?? "", claimTiers) : [];
  const identity = by("identity") ? claimLines(by("identity")?.content_md ?? "", claimTiers) : [];
  const src = by("sources_and_citations");
  return { facts: [...identity, ...slotRows].filter((r) => r.kind === "FACT"), gaps: slotRows.filter((r) => r.kind === "GAP"), slotFieldCount: slotRows.length, sourceUrl: src ? (/^Source:\s*(\S+)\s*$/m.exec(src.content_md)?.[1] ?? null) : null };
}
const KEY_DATE_SLOTS = new Set(["effective_date", "due_date", "primary_deadline"]);
/** FACT rows split into key dates and the rest, each in order. */
export function splitKeyDateFacts(facts: RecordFactRow[]): { dateFacts: RecordFactRow[]; otherFacts: RecordFactRow[] } {
  return { dateFacts: facts.filter((f) => KEY_DATE_SLOTS.has(f.slotKey)), otherFacts: facts.filter((f) => !KEY_DATE_SLOTS.has(f.slotKey)) };
}
