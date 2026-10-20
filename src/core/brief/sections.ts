// Ported from old_repo/src/lib/agent/extract-sections.ts (lines 37-222)
// Ported from old_repo/src/lib/agent/formats/prose-extractor.ts (lines 6-47)
// Ported from old_repo/src/lib/agent/format-spec.ts (lines 1-33)
// Ported from old_repo/src/lib/agent/extract-registry.ts (lines 1-23)
// Ported from old_repo/src/lib/agent/formats/timeline-section.mjs (lines 7-81)
// Ported from old_repo/src/lib/agent/brief-section-strip.mjs (lines 4-35)
// Ported from old_repo/src/lib/agent/claim-ledger-block.ts (lines 12-27)
// Ported from old_repo/src/lib/agent/section-markers.mjs (lines 1-95)
// Ported from old_repo/src/lib/sources/source-growth.ts (lines 277-298)
// Ported from old_repo/src/lib/sources/fetch-quality.ts (lines 1-35)
// One section walker, the five format specs (from the contract table, with role tags), and the body hygiene helpers.
import { FORMATS, type FormatDef, type SectionDef } from "./contract";

export interface ExtractedSection {
  heading: string;
  contentMarkdown: string;
  firstParagraphs: string[];
  hasContent: boolean;
}
export interface SectionRow { section_key: string; section_order: number; content_md: string; is_conditional: boolean }
export interface FormatSpec extends FormatDef { extract(fullBrief: string): SectionRow[] }

/** Strip bold/italic wrappers, a leading "Section N <sep>" and a leading "N." or "N)" from a heading payload. */
function normaliseHeading(raw: string): string {
  return raw.trim().replace(/^\*+\s*/, "").replace(/\s*\*+$/, "").replace(/^section\s+\d+\s*[—–\-:.)]+\s*/i, "").replace(/^\d+\s*[.)]\s*/, "").trim();
}
/** Heading equality: case-insensitive, whitespace-folded, -ize/-ise tolerant. */
const headingsMatch = (a: string, b: string): boolean => {
  const n = (s: string) => s.toLowerCase().replace(/iz/g, "is").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
};
const headingNumber = (payload: string): string | null => /^(?:section\s+)?0*(\d+)\s*[.):\-—–]/i.exec(payload.trim().replace(/^\*+\s*/, ""))?.[1] ?? null;

/** Up to `maxCount` leading paragraphs, skipping rules and standalone H2/H3 sub-headings. */
function splitFirstParagraphs(body: string, maxCount: number): string[] {
  const out: string[] = [];
  for (const blk of body.split(/\n{2,}/)) {
    const t = blk.trim();
    if (!t || /^[-*_]{3,}$/.test(t) || (/^#{2,3}\s+/.test(t) && !t.includes("\n"))) continue;
    out.push(t);
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * THE walker: lines up to the next heading of equal or higher level than the matched one, code fences honoured. An H1 match
 * owns its H2 sub-headings; an H2 match ends at the next H1 or H2. `match` decides which heading starts the section.
 */
function walk(fullBrief: string, match: (payload: string) => boolean): ExtractedSection | null {
  let inFence = false;
  let capturing = false;
  let level = 1;
  let found = "";
  const captured: string[] = [];
  for (const line of fullBrief.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (capturing) captured.push(line);
      continue;
    }
    if (inFence) {
      if (capturing) captured.push(line);
      continue;
    }
    const m = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!capturing) {
      if (m && match(m[2] ?? "")) {
        capturing = true;
        level = (m[1] ?? "#").length;
        found = normaliseHeading(m[2] ?? "");
      }
      continue;
    }
    if (m && (m[1] ?? "#").length <= level) break;
    captured.push(line);
  }
  if (!capturing) return null;
  const contentMarkdown = captured.join("\n").replace(/^\n+|\n+$/g, "");
  const firstParagraphs = splitFirstParagraphs(contentMarkdown, 3);
  return { heading: found, contentMarkdown, firstParagraphs, hasContent: firstParagraphs.length > 0 && firstParagraphs.reduce((n, p) => n + p.length, 0) > 50 };
}
/** The section whose heading carries the NUMBER `key`, whatever the heading text. */
const extractSectionByNumber = (fullBrief: string, key: string): ExtractedSection | null => (fullBrief && key != null ? walk(fullBrief, (p) => headingNumber(p) === String(key)) : null);
/** The section whose normalised heading equals `headingText`. */
export const extractSectionByHeading = (fullBrief: string, headingText: string): ExtractedSection | null => {
  if (!fullBrief || !headingText) return null;
  const target = normaliseHeading(headingText);
  return walk(fullBrief, (p) => headingsMatch(normaliseHeading(p), target));
};

const present = (s: ExtractedSection | null): boolean => !!s && !!s.contentMarkdown.trim();

function proseExtractor(sections: readonly SectionDef[]) {
  return (fullBrief: string): SectionRow[] => {
    const rows: SectionRow[] = [];
    if (!fullBrief) return rows;
    for (const sec of sections) {
      // Number first (a numbered heading resolves whatever its text), then the heading, then each alternate.
      let got = extractSectionByNumber(fullBrief, sec.key);
      for (const h of [sec.heading, ...(sec.headingAlts ?? [])]) {
        if (present(got)) break;
        got = extractSectionByHeading(fullBrief, h);
      }
      const body = (got?.contentMarkdown ?? "").trim();
      if (!body || /^\*?no content for this section/i.test(body)) continue; // an honest omission note is no row
      rows.push({ section_key: sec.key, section_order: sec.order, content_md: body, is_conditional: sec.conditional });
    }
    return rows;
  };
}

export const FORMAT_SPECS: readonly FormatSpec[] = FORMATS.map((f) => ({ ...f, extract: proseExtractor(f.sections) }));
const BY_ITEM_TYPE = new Map(FORMAT_SPECS.flatMap((s) => s.itemTypes.map((t) => [t, s] as const)));
export const specForItemType = (itemType: string | null | undefined): FormatSpec | null => (itemType ? (BY_ITEM_TYPE.get(itemType) ?? null) : null);
const specForFormat = (formatType: string | null | undefined): FormatSpec | null => FORMAT_SPECS.find((s) => s.formatType === formatType) ?? null;
export const sectionWithRole = (formatType: string, role: "timeline" | "do_now" | "sources"): SectionDef[] => specForFormat(formatType)?.sections.filter((s) => s.roles?.includes(role)) ?? [];

/** full_brief to the format's present, non-empty section rows (what sectionBrief writes). */
export const extractSections = (fullBrief: string, itemType: string | null | undefined): SectionRow[] => specForItemType(itemType)?.extract(fullBrief) ?? [];

/**
 * The format's own timeline section, or null. The regulatory format keeps the heading-only lookup (canonical heading, then the
 * section-sign alternate: never number-first, which could pick a different numbered section); every other format is
 * number-first, then heading, then alternates.
 */
export function findTimelineSection(body: string, formatType: string | null | undefined): ExtractedSection | null {
  const def = sectionWithRole(formatType ?? "", "timeline")[0];
  if (!def) return null;
  const src = String(body ?? "");
  const headings = [def.heading, ...(def.headingAlts ?? [])];
  if (formatType !== "regulatory_fact_document") {
    const n = extractSectionByNumber(src, def.key);
    if (present(n)) return n;
  }
  for (const h of headings) {
    const got = extractSectionByHeading(src, h);
    if (formatType === "regulatory_fact_document" ? got : present(got)) return got;
  }
  return null;
}

const SOURCES_LEAD = /^(?:sources\b|new sources\b|sources identified\b|additional sources\b|corroborating sources\b|source notes\b)/;
const titleOf = (raw: string) => raw.replace(/^\s*\d+[.)]\s*/, "").replace(/\*\*/g, "").trim().toLowerCase();
/** The brief without its Sources section and every trailing pipeline-artifact section (fail-closed tail drop). */
export function stripSourcesSection(md: string | null | undefined): string {
  const out: string[] = [];
  for (const line of String(md ?? "").split(/\r?\n/)) {
    const h = /^(#{1,2})\s+(.*)$/.exec(line);
    if (h && SOURCES_LEAD.test(titleOf(h[2] ?? ""))) break;
    out.push(line);
  }
  return out.join("\n").trimEnd();
}

/** INV-092: no internal marker reaches a stored body. */
const LEDGER_NAME = "CLAIM_PROVENANCE_LEDGER";
const LEDGER_OPEN = `<<<${LEDGER_NAME}`;
const LEDGER_CLOSE = `${LEDGER_NAME}>>>`;
const JSON_LITERAL_MAX_PROSE_CHARS = 40;
const MARKER_PATTERNS = [
  { id: "sentinel-open", re: /<<</g },
  { id: "claim-ledger", re: new RegExp(LEDGER_NAME, "g") },
  { id: "provenance-token", re: /_PROVENANCE/g },
];
const EXCERPT = 80;

/** Bracket-match one object literal at `start`; string-aware. Returns its exclusive end or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < Math.min(text.length, start + 6000); i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}
export function findInternalMarkers(text: unknown): { id: string; excerpt: string }[] {
  if (typeof text !== "string" || !text) return [];
  const hits: { id: string; excerpt: string }[] = [];
  for (const p of MARKER_PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(text);
    if (m) hits.push({ id: p.id, excerpt: text.slice(Math.max(0, m.index - 10), m.index + EXCERPT).replace(/\s+/g, " ") });
  }
  for (const open of text.matchAll(/\{\s*"[^"\n]{1,80}"\s*:/g)) {
    const end = objectEnd(text, open.index ?? 0);
    if (end !== -1 && end - (open.index ?? 0) > JSON_LITERAL_MAX_PROSE_CHARS) {
      hits.push({ id: "json-object-literal", excerpt: text.slice(open.index, (open.index ?? 0) + EXCERPT).replace(/\s+/g, " ") });
      break;
    }
  }
  return hits;
}
export const describeMarkers = (hits: { id: string; excerpt: string }[]): string => hits.map((h) => `${h.id} "${h.excerpt}"`).join("; ");
/** The refusal every writer of a stored body uses. */
export function assertNoInternalMarkers(text: string, where: string): string {
  const hits = findInternalMarkers(text);
  if (hits.length) throw new Error(`internal_marker_in_body: ${where} refused to persist a body carrying ${describeMarkers(hits)}`);
  return text;
}
/** Remove every ledger block from a body, valid or not (an unterminated opener runs to the end). */
export function stripClaimLedgerBlocks(text: string | null | undefined): string {
  const original = String(text ?? "");
  if (!original.includes(LEDGER_NAME)) return original;
  return original.replace(new RegExp(`${LEDGER_OPEN}[\\s\\S]*?${LEDGER_CLOSE}`, "g"), "").replace(new RegExp(`${LEDGER_OPEN}[\\s\\S]*$`), "").replace(new RegExp(LEDGER_CLOSE, "g"), "").replace(/\s+$/, "");
}

export interface CitedSource { name: string; url: string; tier_estimate: number; rejection_reason: string | null }
/** The rows of the brief's "New Sources Identified" table (name, url, tier estimate); a blocked row is carried with its reason. */
export function parseNewSources(brief: string | null | undefined): CitedSource[] {
  const m = /#+\s*New Sources Identified[\s\S]*?(?=\n#+\s|\s*$)/i.exec(brief ?? "");
  if (!m) return [];
  const out: CitedSource[] = [];
  for (const line of m[0].split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((s) => s.trim()).filter(Boolean);
    const urlCell = cells.find((c) => /https?:\/\//.test(c));
    const url = urlCell ? /https?:\/\/[^\s)|]+/.exec(urlCell)?.[0] : undefined;
    const name = (cells[0] ?? "").replace(/\*+/g, "");
    if (cells.length < 2 || !url || /^source name$/i.test(name)) continue;
    const tierCell = cells.find((c) => /^\(?[1-7]\)?$/.test(c));
    out.push({ name, url, tier_estimate: tierCell ? parseInt(tierCell.replace(/\D/g, ""), 10) : 5, rejection_reason: /cloudflare|blocked|\b403\b|captcha|access denied/i.test(line) ? "cloudflare_block" : null });
  }
  return out;
}

const BRIEF_FAILURE_PATTERNS = [/content unavailable[ ,.\-]*source/i, /\baccess blocked\b/i, /\baccess denied\b/i, /source returned (\d{3}|an? )/i, /could not be accessed/i, /\b403 forbidden\b/i, /\b401 unauthor[iz]ed\b/i, /\b404 not found\b/i, /\b502 bad gateway\b/i, /\b503 service unavailable\b/i];
/** A brief whose first kilobyte reads as a fetch-failure explanation must not persist (research-or-erase). */
export function checkBriefContent(body: string | null | undefined): { ok: boolean; reason: string | null } {
  const probe = (body ?? "").slice(0, 1_000);
  const re = BRIEF_FAILURE_PATTERNS.find((r) => r.test(probe));
  return re ? { ok: false, reason: `brief_failure_${re.source.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}` } : { ok: true, reason: null };
}
