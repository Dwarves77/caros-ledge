// Ported from old_repo/scripts/turns/theme-briefs/schema.mjs (lines 1-307)
// The theme-brief contract: the five sections, their ceilings, the surface headings, and the validator of one authored entry against the theme's LIVE material. A figure or acronym in a section is
// allowed only inside a listed claim's text, a labelled analysis paragraph, a heading, a member title or a gap description; a claim must name a grounded claim of a live member. Pure: the caller loads the material.
import { computeMemberHash } from "@/core/flywheel/themes";

export const THEME_BRIEF_SECTIONS = ["connection", "meaning", "ramifications", "watch", "gaps"] as const;
export type ThemeSection = (typeof THEME_BRIEF_SECTIONS)[number];
export const SECTION_HEADINGS: Readonly<Record<ThemeSection, string>> = { connection: "Connection", meaning: "What it means", ramifications: "Ramifications", watch: "Watch", gaps: "Gaps" };
export const SECTION_CEILINGS: Readonly<Record<ThemeSection, number>> = { connection: 2000, meaning: 2500, ramifications: 5000, watch: 3000, gaps: 1500 };
export const TITLE_CEILING = 160;
/** connection_themes.surfaces value to the heading a ramifications subsection uses for it. */
export const SURFACE_HEADING: Readonly<Record<string, string>> = { regulations: "Regulations", market: "Market Intel", research: "Research", operations: "Operations" };

const REQUIRED_NONEMPTY: readonly ThemeSection[] = ["connection", "meaning", "ramifications", "watch"];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A paragraph or list line opening with one of these labels is the author's labelled analysis, exempt from the uncited-figure check.
const ANALYSIS_LABEL_RE = /^\s*(?:[-*]\s+|\d+[.)]\s+)?[*_]{0,3}(?:Analytical inference|Operational implication|Legal Confirmation Required)\s*:/i;
const LABEL_WORDS = new Set(["ACTION", "REQUIRED", "COST", "ALERT", "WINDOW", "CLOSING", "COMPETITIVE", "EDGE", "MONITORING", "FACT", "ANALYSIS", "LEGAL", "GAP", "NOT", "AND", "THE", "FOR"]);

type Obj = Record<string, unknown>;
export const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
export const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every [start, end) range where `needle` occurs in `text`, whitespace-flexible. */
function rangesOf(text: string, needle: string, flags = "g"): [number, number][] {
  const n = typeof needle === "string" ? needle.trim() : "";
  if (!n) return [];
  const out: [number, number][] = [];
  const re = new RegExp(n.split(/\s+/).map(escapeRe).join("\\s+"), flags);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

/** Ranges of labelled analysis blocks and heading lines. */
function exemptBlockRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let offset = 0;
  let inAnalysis = false;
  for (const line of text.split("\n")) {
    const [start, end] = [offset, offset + line.length];
    offset = end + 1;
    if (line.trim() === "") inAnalysis = false;
    else if (/^\s*#{1,6}\s/.test(line)) {
      out.push([start, end]);
      inAnalysis = false;
    } else {
      if (ANALYSIS_LABEL_RE.test(line)) inAnalysis = true;
      else if (/^\s*(?:[-*]\s+|\d+[.)]\s+)/.test(line)) inAnalysis = false;
      if (inAnalysis) out.push([start, end]);
    }
  }
  return out;
}
const within = (ranges: readonly [number, number][], pos: number): boolean => ranges.some(([a, b]) => pos >= a && pos < b);

/** The number and acronym tokens of a text (an acronym is three or more capitals, the lexical stand-in for a named instrument or body). */
export function figureTokens(text: unknown): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? "");
  for (const m of s.matchAll(/\d+(?:[.,]\d+)*%?/g)) out.add(m[0]);
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9&]{2,}\b/g)) if (!LABEL_WORDS.has(m[0])) out.add(m[0]);
  return out;
}

export interface Cover { claimTexts?: string[]; memberTitles?: string[]; gapDescriptions?: string[]; allowedTokens?: ReadonlySet<string> | null }
/** The figure tokens of `text` that no listed claim, labelled analysis block, heading, member title, gap description or edge-basis token covers. Limits: a fact written without digits or an acronym is not detected. */
export function findUncitedFigures(text: unknown, cover: Cover = {}): string[] {
  if (typeof text !== "string" || !text) return [];
  const covered = [...exemptBlockRanges(text)];
  for (const c of cover.claimTexts ?? []) covered.push(...rangesOf(text, c));
  for (const t of cover.memberTitles ?? []) covered.push(...rangesOf(text, t, "gi"));
  for (const g of cover.gapDescriptions ?? []) covered.push(...rangesOf(text, g));
  const found: string[] = [];
  const allowed = cover.allowedTokens ?? null;
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*%?/g)) {
    const pos = m.index ?? 0;
    const before = text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos);
    if (/^\s*$/.test(before) && /^[.)]\s/.test(text.slice(pos + m[0].length, pos + m[0].length + 2))) continue; // an ordered-list marker
    if (!within(covered, pos) && !allowed?.has(m[0])) found.push(m[0]);
  }
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9&]{2,}\b/g)) if (!LABEL_WORDS.has(m[0]) && !within(covered, m.index ?? 0) && !allowed?.has(m[0])) found.push(m[0]);
  return found;
}

/** A ramifications block as { heading: body } plus its structural problems. */
export function parseRamifications(text: string): { subs: Map<string, string>; problems: string[] } {
  const problems: string[] = [];
  const subs = new Map<string, string>();
  let current: string | null = null;
  let preamble = "";
  for (const line of String(text ?? "").split("\n")) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1] as string;
      if (subs.has(current)) problems.push(`duplicate ramifications subsection "${current}"`);
      else subs.set(current, "");
    } else if (current === null) preamble += line;
    else subs.set(current, `${subs.get(current)}${line}\n`);
  }
  if (preamble.trim()) problems.push("ramifications text before the first '### <Surface>' subsection");
  return { subs, problems };
}

export interface ThemeContext {
  themesById: Map<string, { id: string; member_ids: string[]; surfaces: string[] }>;
  membersById: Map<string, { title?: string | null; claim_ids: Set<string>; event_ids: Set<string> }>;
  gapsByTheme?: Map<string, { description: string }[]>;
  basisTokensByTheme?: Map<string, Set<string>>;
}

/** Validate ONE entry: the refusal reasons (empty means valid). */
export function validateThemeBriefEntry(entry: unknown, i: number, ctx: ThemeContext): string[] {
  const where = `entry ${i}`;
  if (!isObj(entry)) return [`${where}: not an object`];
  if (!nonEmptyStr(entry.theme_id)) return [`${where}: theme_id is missing`];
  const tag = `${where} (theme ${entry.theme_id})`;
  const theme = ctx.themesById.get(entry.theme_id);
  if (!theme) return [`${tag}: unknown theme (no live connection_themes row with this id)`];
  const errs: string[] = [];
  if (!nonEmptyStr(entry.member_hash)) errs.push(`${tag}: member_hash is missing`);
  else if (entry.member_hash !== computeMemberHash(theme.member_ids)) errs.push(`${tag}: member_hash does not match the live membership (authored against ${entry.member_hash}, live ${computeMemberHash(theme.member_ids)}); re-export the bundle and re-author`);
  if (!nonEmptyStr(entry.title)) errs.push(`${tag}: title is missing`);
  else if (entry.title.length > TITLE_CEILING) errs.push(`${tag}: title is ${entry.title.length} characters, ceiling ${TITLE_CEILING}`);
  else if (UUID_RE.test(entry.title)) errs.push(`${tag}: title carries an id; cite members by title`);
  if (!isObj(entry.sections)) return [...errs, `${tag}: sections must be an object with ${THEME_BRIEF_SECTIONS.join(", ")}`];
  const sections = entry.sections;
  for (const k of Object.keys(sections)) if (!(THEME_BRIEF_SECTIONS as readonly string[]).includes(k)) errs.push(`${tag}: unknown section "${k}"`);
  for (const k of THEME_BRIEF_SECTIONS) {
    const v = sections[k];
    if (typeof v !== "string") errs.push(`${tag}: section "${k}" is missing or not a string`);
    else {
      if (REQUIRED_NONEMPTY.includes(k) && v.trim() === "") errs.push(`${tag}: required section "${k}" is empty`);
      if (v.length > SECTION_CEILINGS[k]) errs.push(`${tag}: section "${k}" is ${v.length} characters, ceiling ${SECTION_CEILINGS[k]}`);
      if (UUID_RE.test(v)) errs.push(`${tag}: section "${k}" carries an id; cite members by title, never by id`);
    }
  }
  const gaps = ctx.gapsByTheme?.get(entry.theme_id) ?? [];
  if (gaps.length > 0 && typeof sections.gaps === "string" && sections.gaps.trim() === "") errs.push(`${tag}: the bundle lists ${gaps.length} gap(s) for this theme but section "gaps" is empty`);

  // Ramifications: one subsection per surface the theme spans, and none for a surface it does not.
  if (typeof sections.ramifications === "string" && sections.ramifications.trim() !== "") {
    const spanned = new Set(theme.surfaces.map((s) => SURFACE_HEADING[s]).filter((h): h is string => !!h));
    const { subs, problems } = parseRamifications(sections.ramifications);
    for (const p of problems) errs.push(`${tag}: ${p}`);
    const known = new Set(Object.values(SURFACE_HEADING));
    for (const [heading, body] of subs) {
      if (!known.has(heading)) errs.push(`${tag}: ramifications subsection "${heading}" is not one of ${[...known].join(", ")}`);
      else if (!spanned.has(heading)) errs.push(`${tag}: ramifications subsection "${heading}" is for a surface this theme does not span`);
      else if (body.trim() === "") errs.push(`${tag}: ramifications subsection "${heading}" is empty`);
    }
    for (const heading of spanned) if (!subs.has(heading)) errs.push(`${tag}: the theme spans "${heading}" but ramifications has no subsection for it`);
  }

  // Claims: every one names a live member and the grounded claim (or, in watch, the forward event) ids of that member.
  const claimTexts = new Map<string, string[]>(THEME_BRIEF_SECTIONS.map((s) => [s, []]));
  if (!Array.isArray(entry.claims)) errs.push(`${tag}: claims must be an array`);
  else {
    const live = new Set(theme.member_ids);
    entry.claims.forEach((c: unknown, ci: number) => {
      const ct = `${tag} claims[${ci}]`;
      if (!isObj(c)) return void errs.push(`${ct}: not an object`);
      if (!(THEME_BRIEF_SECTIONS as readonly string[]).includes(String(c.section))) return void errs.push(`${ct}: section "${String(c.section)}" is not one of ${THEME_BRIEF_SECTIONS.join(", ")}`);
      const section = c.section as ThemeSection;
      if (!nonEmptyStr(c.text)) return void errs.push(`${ct}: text is missing`);
      if (rangesOf(typeof sections[section] === "string" ? (sections[section] as string) : "", c.text).length === 0) errs.push(`${ct}: text does not appear in section "${section}"`);
      else claimTexts.get(section)?.push(c.text);
      if (!nonEmptyStr(c.member_id) || !live.has(c.member_id)) return void errs.push(`${ct}: member_id is not a live member of this theme`);
      const member = ctx.membersById.get(c.member_id);
      if (!member) return void errs.push(`${ct}: member ${c.member_id} has no loaded claims, cannot verify claim_ids`);
      if (!Array.isArray(c.claim_ids) || c.claim_ids.length === 0) return void errs.push(`${ct}: claim_ids must be a non-empty array`);
      for (const id of c.claim_ids) if (typeof id !== "string" || !(member.claim_ids.has(id) || (section === "watch" && member.event_ids.has(id)))) errs.push(`${ct}: claim id ${JSON.stringify(id)} is not a grounded claim of member ${c.member_id}${section === "watch" ? " (or one of its forward events)" : ""}`);
    });
  }

  // Uncited figures, per section.
  const memberTitles = theme.member_ids.map((id) => ctx.membersById.get(id)?.title).filter((t): t is string => !!t);
  const gapDescriptions = gaps.map((g) => g.description).filter(Boolean);
  for (const k of THEME_BRIEF_SECTIONS) {
    const loose = findUncitedFigures(sections[k], { claimTexts: claimTexts.get(k) ?? [], memberTitles, gapDescriptions, allowedTokens: ctx.basisTokensByTheme?.get(entry.theme_id) ?? null });
    if (loose.length) {
      const uniq = [...new Set(loose)];
      errs.push(`${tag}: section "${k}" states ${uniq.slice(0, 6).map((t) => JSON.stringify(t)).join(", ")}${uniq.length > 6 ? " and more" : ""} outside any listed claim or labelled analysis paragraph; list a claim for it or write it as '*Analytical inference:* ...'`);
    }
  }
  return errs;
}

/** brief_md: the title, then the sections in order under fixed headings. An empty gaps section is omitted. */
export function renderBriefMd(entry: { title: string; sections: Partial<Record<ThemeSection, unknown>> }): string {
  const parts = [`# ${entry.title.trim()}`];
  for (const k of THEME_BRIEF_SECTIONS) {
    const body = String(entry.sections[k] ?? "").trim();
    if (body) parts.push(`## ${SECTION_HEADINGS[k]}\n\n${body}`);
  }
  return `${parts.join("\n\n")}\n`;
}
