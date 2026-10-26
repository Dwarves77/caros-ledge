// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 299-649)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 826-921)
import { toText } from "./classify-body";

export interface TitleResult {
  title: string;
  origin: string;
}
/** <title> first, then the first <h1>; null when neither survives stripping. An OJ file name is what EUR-Lex puts in <title> for C-series notices and is never the act's title. */
export function extractTitleFromHtml(html: unknown): TitleResult | null {
  const h = String(html ?? "");
  const t = toText(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (t && !isOjFileName(t)) return { title: t, origin: "captured_title" };
  const h1 = toText(h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  return h1 ? { title: h1, origin: "captured_heading" } : null;
}
/** True for an Official Journal file name such as "L_2006209EN.01000101.xml". */
const isOjFileName = (s: unknown): boolean => /^[A-Z]_\d{7}[A-Z]{2}\.\d{6,}\.xml$/i.test(String(s ?? "").trim());

const OJ_ACT_TITLE_RE = /\b((?:COMMISSION|COUNCIL|EUROPEAN PARLIAMENT AND (?:OF THE )?COUNCIL|REGULATION|DIRECTIVE|DECISION|RECOMMENDATION)\b[\s\S]{0,400}?\((?:\d{4}\/[A-Z]?\s?\d+(?:\/\d+)?|\d{4}\/\d+\/[A-Z]+)\))/;
// The act heading wherever it starts, never the page chrome around it (no alternative contains "EUR-Lex" or "Official Journal"); \d{2,4} so a pre-2000 two-digit-year reference keeps its prefix.
const ACT_HEADING_RE = /(Decision of the EEA Joint Committee|\d{2,4}\/\d+\/(?:EEC|EC|EU|Euratom):\s*(?:Commission|Council)\s+(?:Implementing\s+|Delegated\s+)?Decision|Commission\s+(?:Implementing\s+|Delegated\s+)?Decision|Council\s+(?:Implementing\s+|Delegated\s+)?Decision|Decision\s+(?:No\.?\s*\d|\((?:EU|EC)\)\s*\d+\/\d+))/i;
// Markers that close a title once the heading has started, matched in source order, the earliest wins.
const TITLE_TERMINATORS = [" Official Journal", "THE EUROPEAN COMMISSION,", "THE COUNCIL OF THE EUROPEAN UNION,", "THE EEA JOINT COMMITTEE,", "Having regard", "(Text with EEA relevance)"];
// The OJ series citation ("(2023/C 154/05)" or the bare form) has no fixed prefix; left uncaught a hard cap could land inside its opening paren.
const OJ_SERIES_CITATION_RE = /\(?\s*\d{4}\/C\s?\d+\/\d+\s*\)?/;
const ACT_TITLE_MIN_LEN = 20;
const ACT_TITLE_MAX_LEN = 400;
const isUsableActTitle = (t: string): boolean => !!t && t.length >= ACT_TITLE_MIN_LEN && t.length <= ACT_TITLE_MAX_LEN && !/^EUR-Lex/i.test(t) && !/^Official Journal/i.test(t);
/** Never emit an unclosed "(": strip the last "(" and what follows while more opens than closes remain. */
function trimUnbalancedOpenParen(s: string): string {
  let out = s;
  while ((out.match(/\(/g) ?? []).length > (out.match(/\)/g) ?? []).length) {
    const i = out.lastIndexOf("(");
    if (i < 0) break;
    out = out.slice(0, i).trim();
  }
  return out;
}
/** The act title inside an OJ body lead, or null. Tier 1: a heading through its trailing OJ reference. Tier 2: the heading found alone and bounded by the earliest terminator or citation (never cut mid-word, never an unclosed paren). */
function extractOjActTitle(text: unknown): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const withRef = t.match(OJ_ACT_TITLE_RE)?.[1]?.trim();
  if (withRef && isUsableActTitle(withRef)) return withRef;
  const heading = t.match(ACT_HEADING_RE);
  if (!heading || heading.index === undefined) return null;
  const rest = t.slice(heading.index);
  let end = rest.length;
  for (const term of TITLE_TERMINATORS) {
    const i = rest.indexOf(term);
    if (i >= 0 && i < end) end = i;
  }
  const cite = rest.match(OJ_SERIES_CITATION_RE);
  if (cite?.index !== undefined && cite.index < end) end = cite.index;
  if (end > ACT_TITLE_MAX_LEN) end = ACT_TITLE_MAX_LEN;
  if (end < rest.length && /\w/.test(rest[end - 1] ?? "") && /\w/.test(rest[end] ?? "")) {
    const space = rest.lastIndexOf(" ", end - 1);
    if (space > 0) end = space;
  }
  const title = trimUnbalancedOpenParen(rest.slice(0, end).replace(/\s+/g, " ").trim());
  return isUsableActTitle(title) ? title : null;
}
/** The act title when the lead carries one, else the first ~300 characters with any leading OJ file name removed. */
function bodyLeadTitle(text: string): TitleResult | null {
  const act = extractOjActTitle(text);
  if (act) return { title: act, origin: "captured_body_act_title" };
  const lead = String(text).replace(/^\S+\.xml\s+/i, "").slice(0, 300).trim();
  return lead ? { title: lead, origin: "captured_body_lead" } : null;
}
/** A fresh EUR-Lex clean-text page: <title>/<h1> first, else the body lead (the endpoint opens with the act's own title). */
export function extractEurlexTitle(html: unknown): TitleResult | null {
  const heading = extractTitleFromHtml(html);
  if (heading) return heading;
  const text = toText(html);
  return text ? bodyLeadTitle(text) : null;
}
/** A Cellar XHTML act: the `p.oj-doc-ti` lines joined by a space; older acts: the first <strong> after a legacy "EUR-Lex - CELEX" <title>; else the body lead (never <title>, which is the OJ file name here). */
export function extractCellarTitle(html: unknown): TitleResult | null {
  const h = String(html ?? "");
  const rawParts = [...h.matchAll(/<p[^>]*class="[^"]*\boj-doc-ti\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => toText(m[1])).filter(Boolean);
  const parts: string[] = [];
  for (const part of rawParts) {
    if (/^['‘’"“]?ANNEX(E)?\b/i.test(part.trim())) break;
    parts.push(part);
  }
  if (parts.length) return { title: parts.join(" "), origin: "cellar_doc_title" };
  if (/<title[^>]*>\s*EUR-Lex\s*-\s*[0-9A-Z()]+\s*-\s*[A-Z]{2}\s*<\/title>/i.test(h)) {
    const t = toText(h.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? "");
    if (t.length >= 20) return { title: t, origin: "cellar_legacy_title" };
  }
  const text = toText(h);
  return text ? bodyLeadTitle(text) : null;
}
const EEA_MARKER = "(Text with EEA relevance)";
const ANNEX_HEADING_AFTER_MARKER = /^\s+['‘’"“]?(?:ANNEX(?:\s|$)|$)/;
const QUOTED_ANNEX = /\s['‘’"“]ANNEX\b/;
/**
 * The official act title: a captured title (or the joined heading elements of a page) carries the page's annex headings after the title itself. The title ends at the first "(Text with EEA relevance)" when an annex heading follows it,
 * else before the first quoted ANNEX; a title that still holds an ANNEX word after that cut cannot be split cleanly and is returned as captured. Migration 0140 repairs stored titles by the same two steps, so the two stay one rule.
 */
function officialTitle(title: string): string {
  const at = title.indexOf(EEA_MARKER);
  if (at >= 0 && ANNEX_HEADING_AFTER_MARKER.test(title.slice(at + EEA_MARKER.length))) return title.slice(0, at + EEA_MARKER.length);
  const quoted = title.search(QUOTED_ANNEX);
  return quoted >= 0 && !/\bANNEX\b/.test(title.slice(0, quoted)) ? title.slice(0, quoted) : title;
}

/**
 * The title for a row: the capture's own resolved title, else its HTML, else (for a text-only capture) the OJ act title or, when allowed, the body lead, else the source name with the identifier.
 * `allowBodyLeadFallback: false` is for re-titling an existing row, where a raw page-lead slice (often page chrome) is never an honest title.
 */
export function buildTitleForRow({ capture, source, identifier, allowBodyLeadFallback = true }: { capture: { text?: string | null; html?: string | null; title?: string | null; titleOrigin?: string | null }; source: { name?: string | null; url?: string | null }; identifier?: string | null; allowBodyLeadFallback?: boolean }): TitleResult {
  let title = capture?.title ?? null;
  let origin = capture?.titleOrigin ?? null;
  if (!title && capture?.html) {
    const t = extractTitleFromHtml(capture.html);
    if (t) ({ title, origin } = { title: t.title, origin: t.origin });
  }
  if (!title && capture?.html == null && capture?.text) {
    const act = extractOjActTitle(capture.text);
    if (act) ({ title, origin } = { title: act, origin: "captured_body_act_title" });
    else if (allowBodyLeadFallback) {
      const lead = bodyLeadTitle(capture.text);
      if (lead) ({ title, origin } = lead);
    }
  }
  if (!title) return { title: identifier ? `${source.name ?? source.url} — ${identifier}` : String(source.name ?? source.url), origin: "source_name_fallback" };
  return { title: officialTitle(title), origin: origin ?? "captured_title" };
}

// EUR-Lex's in-force widget (interactive pages only) and Cellar's own conversion-metadata fingerprint (an RDF description served in place of the act's body).
const FORCE_INDICATOR_RE = /<p[^>]*class="[^"]*\bforceIndicator\b[^"]*"[^>]*>[\s\S]{0,300}?<\/span>\s*([^<]{1,200})/i;
const CELLAR_METADATA_FINGERPRINT_RE = /\bcdm:CDM_\S+\b[\s\S]{0,200}?\bmetaconvJar:\S+\b[\s\S]{0,80}?\bbuilddate:\S+(?:\s+[\d:]+)?/i;
/** Cellar's conversion-metadata fingerprint inside a capture (`cdm:`, `metaconvJar:` and `builddate:` together: no legal text carries them); `span` is verbatim. Null in the common case. */
export function detectCellarGarbledMetadata(capturedText: unknown): { span: string } | null {
  const m = String(capturedText ?? "").match(CELLAR_METADATA_FINGERPRINT_RE);
  return m ? { span: m[0] } : null;
}
/** EUR-Lex's structurally anchored in-force status widget, never a bare substring scan; null when the widget is absent. */
export function detectNotInForce(capturedText: unknown): { span: string; statusText: string; notInForce: boolean } | null {
  const m = String(capturedText ?? "").match(FORCE_INDICATOR_RE);
  const statusText = m?.[1]?.trim();
  return m && statusText ? { span: m[0], statusText, notInForce: /^no longer in force\b/i.test(statusText) } : null;
}


const PRESERVED_ACRONYMS = new Set([
  "EU", "EC", "EEC", "EUR", "EEA", "CBAM", "ETS", "IMO", "ESG",
  "GHG", "LNG", "PFAS", "PCR", "US", "USA", "EPA", "CARB", "UK",
  "UN", "ISO", "EN",
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
]);

const LOWERCASE_TITLE_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "for", "nor", "on", "at",
  "to", "from", "by", "of", "in", "with", "as", "into", "onto", "over",
]);

/**
 * Normalizes document titles for clear display across all platform surfaces:
 * - Strips trailing appended Annex blocks (e.g. "ANNEX I ... ANNEX III") into an explicit subtitle ("Includes Annexes I–III").
 * - Converts shouting all-caps EUR-Lex / catalogue titles into clean title case while preserving core domain acronyms and Roman numerals.
 * - Preserves existing mixed-case or formatted titles intact.
 */
export function normalizeDisplayTitle(rawTitle: string): { title: string; subtitle: string | null } {
  let title = String(rawTitle ?? "").trim();
  if (!title) return { title: "", subtitle: null };

  let subtitle: string | null = null;
  const annexMatch = title.match(/(?:[\s—–,;:-]+|^)(ANNEX(?:ES)?|ANNEXE(?:S)?)\b([\s\S]*)$/i);
  if (annexMatch && annexMatch.index !== undefined) {
    const tail = annexMatch[0];
    const residual = tail
      .replace(/\b(annex(?:es)?|annexe(?:s)?|and|to|through|part|parts)\b/gi, "")
      .replace(/[IVXLCDM\d\s,;—–\-\.\(\)]/gi, "");
    if (!/[a-z]/i.test(residual)) {
      const tokens = tail.match(/\b([IVXLCDM]+|\d+)\b/gi);
      if (tokens && tokens.length > 0) {
        const first = tokens[0]?.toUpperCase();
        const last = tokens[tokens.length - 1]?.toUpperCase();
        if (first && last) {
          subtitle = tokens.length === 1 || first === last ? `Includes Annex ${first}` : `Includes Annexes ${first}–${last}`;
        } else {
          subtitle = "Includes Annex";
        }
      } else {
        subtitle = "Includes Annex";
      }
      title = title.slice(0, annexMatch.index).trim().replace(/[\s—–,;:-]+$/, "");
    }
  }

  const upper = (title.match(/[A-Z]/g) ?? []).length;
  const lower = (title.match(/[a-z]/g) ?? []).length;
  const isShouting = (upper >= 8 && lower === 0) || (upper >= 15 && upper / (upper + lower) > 0.8);

  if (isShouting) {
    const tokens = title.split(/(\s+|[—–\-\/])/);
    let isStart = true;
    title = tokens
      .map((w) => {
        if (/^\s+$/.test(w) || /^[—–\-\/]$/.test(w)) {
          if (/[—–\-]/.test(w)) isStart = true;
          return w;
        }
        const match = w.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9]+(?:['’][a-zA-Z0-9]+)*)([^a-zA-Z0-9]*)$/);
        if (!match) return w;
        const pre = match[1] ?? "";
        const core = match[2] ?? "";
        const post = match[3] ?? "";
        if (!core) return w;
        const upperCore = core.toUpperCase();
        let resCore: string;
        if (PRESERVED_ACRONYMS.has(upperCore)) {
          resCore = upperCore;
        } else if (!isStart && LOWERCASE_TITLE_WORDS.has(core.toLowerCase())) {
          resCore = core.toLowerCase();
        } else {
          // Each apostrophe-separated part is capitalised (O'Brien) unless it is a lone letter after the first (Patlee's, Don't).
          resCore = core.replace(/[a-zA-Z0-9]+/g, (part, at: number) => (at === 0 || part.length > 1 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase()));
        }
        isStart = false;
        return pre + resCore + post;
      })
      .join("");
  }

  return { title, subtitle };
}
