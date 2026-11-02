// The brief validator's rules and their registry (VALID-1, FWD-COVER-1, AUTHOR-FIX-1; LOCK-NO-BLOAT-1 folded the 38 rule files, _text, _sev and types into this one module). A rule is a pure function of a parsed brief and the item's columns:
// it reads no database, no clock and no environment. data/rules.json names every rule (id, refuse or residue, the formats it applies to, the text scope it reads); this module holds the rule functions by id and refuses to load when the two disagree.
// severity-in-vocabulary, urgency-tier-in-vocabulary and topic-tags-vocabulary-and-cap are validateMetadata's own checks (src/core/brief/validate.ts, KINDS) and are not repeated. The rules hash names with node:crypto, so the brief index (client-reachable) does not export this module.
import { z } from "zod";

import { assertVerbatim, isVerbatim } from "@/core/contracts/verbatim";
import { foldHtmlSpace } from "@/core/parse";

import { tokenHash } from "../../contracts/token-hash";
import { FORMAT_TYPES, FORMATS, SEVERITIES } from "../contract";
import datesJson from "../data/date-renderings.json";
import rulePatternsJson from "../data/rule-patterns.json";
import rulesJson from "../data/rules.json";
import namesJson from "../data/workspace-names.json";
import { describeMarkers, findInternalMarkers, normaliseHeading, sectionWithRole } from "../sections";
import { LEGAL_CALLOUT, MONTH_NAMES, toDbSeverity } from "../vocab";

/** One claim of the brief's ledger. `capture` is the text its span must be verbatim in (the item pool for a batch entry, the attributed capture for a stored row). */
export interface BriefClaim { kind: string; section: string; span: string | null; text: string; capture: string | null }
/** The parsed brief. `sections` is keyed by section number; `exempt` is further verbatim text a source adapter found (old-tree rows quote with ASCII marks). */
export interface BriefModel { body: string; format: string; sections: ReadonlyMap<string, string>; claims: readonly BriefClaim[]; exempt: readonly string[];
  /** FWD-COVER-1: the event_date of each entry in the entry's events block, and the dates it states it omits (omitted_events) with the reason. */
  events?: readonly string[]; omitted?: readonly { date: string; reason: string }[] }
/** The item row's columns a rule reads. `severity` is in ADR-052 token form (normalise a display label through severityToken before building this). */
export interface ItemColumns {
  severity: string | null; priority: string | null; urgency_tier: string | null; entry_into_force: string | null; compliance_deadline: string | null;
  what_it_changes: string | null; what_is_it: string | null; why_matters: string | null; topic_tags: readonly string[]; sources_used: readonly string[];
  signal_band: string | null; theme: string | null; format_type: string;
  /** Characters of the item's source pool and whether the metadata carries a requirement trajectory: the depth-accounting rule reads both. */
  pool_chars: number | null; has_trajectory: boolean;
  /** FWD-COVER-1: the ISO dates of the forward events and timeline rows the export supplied for the item. */
  supplied_dates?: readonly string[];
}
export interface Violation { rule: string; detail: string; excerpt: string }
export type Rule = (brief: BriefModel, item: ItemColumns) => Violation | null;

const RULE_PATTERNS = z.object({
  patterns: z.record(z.string(), z.object({ register: z.string(), patterns: z.array(z.object({ re: z.string(), flags: z.string().optional() })).min(1) })),
  limits: z.record(z.string(), z.object({ register: z.string(), min: z.number().optional(), max: z.number().optional(), window: z.number().optional() })),
}).strict().parse(rulePatternsJson);
const COMPILED: Record<string, RegExp[]> = Object.fromEntries(Object.entries(RULE_PATTERNS.patterns).map(([k, v]) => [k, v.patterns.map((p) => new RegExp(p.re, p.flags))]));
export function patternsOf(key: string): RegExp[] {
  const r = COMPILED[key];
  if (!r) throw new Error(`rule-patterns: no pattern list named ${key}`);
  return r;
}
const limitOf = (key: string): { min?: number | undefined; max?: number | undefined; window?: number | undefined } => RULE_PATTERNS.limits[key] ?? {};
const violation = (rule: string, detail: string, text: string): Violation => ({ rule, detail, excerpt: text.replace(/\s+/g, " ").trim().slice(0, 80) });

// The five severity labels and the locked priority, read once from the contract (ADR-052: the token is stored, the space-separated label is rendered from it).
export const LABELS: readonly string[] = SEVERITIES.map((s) => s.label);
export const LABEL_OF: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.db, s.label]));
const PRIORITY_OF: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.db, s.priority]));
/** ItemColumns.severity from a batch entry's metadata.severity (a display label) or a stored value: the ADR-052 token through toDbSeverity; a value it cannot map is kept as written. */
export function severityToken(value: string | null | undefined): string | null {
  try {
    return toDbSeverity(value);
  } catch {
    return value ?? null;
  }
}

const PROSE = new WeakMap<BriefModel, string>();
/** What a removed verbatim run leaves behind: one visible, non-space mark, so a table cell or a sentence that held a quote is not left empty (an empty cell is a defect the structural rule must not invent). */
const VERBATIM_MARK = "￼";
/** The body with verbatim text removed: every «...» run, the source_span of every FACT claim, and the runs an adapter marked exempt (claim_text is the author's own wording and is not exempt). A source's own wording and punctuation are never edited. */
function proseOf(b: BriefModel): string {
  let t = PROSE.get(b);
  if (t === undefined) {
    t = b.body.replace(/«[^»]*»/g, VERBATIM_MARK);
    for (const r of [...b.exempt, ...b.claims.filter((c) => c.kind === "FACT").map((c) => c.span)]) if (r?.trim()) t = t.replace(new RegExp(r.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), VERBATIM_MARK);
    PROSE.set(b, t);
  }
  return t;
}
/** A rule that is one pattern list over the body it is given (the runner hands it the prose view or the whole body, as the registry says). */
function textRule(id: string, key: string): Rule {
  const res = patternsOf(key);
  return (brief) => {
    for (const r of res) {
      const m = r.exec(brief.body);
      if (m) return violation(id, `${key}: ${JSON.stringify(m[0].slice(0, 40))}`, brief.body.slice(m.index));
    }
    return null;
  };
}
/** The rules that are one pattern list: registry id to the list in data/rule-patterns.json. */
const TEXT_RULES: Readonly<Record<string, string>> = {
  "dash-outside-verbatim": "dash", "generic-action-phrase": "generic-action", "tier-phrase-exposure": "tier", "score-or-schema-token": "score-schema", "as-of-has-date": "as-of", "pipeline-narration": "narration",
  "pool-or-slot-narration": "pool-slot", "no-html-entity-outside-spans": "entity", "no-ibid": "ibid", "no-double-hyphen-dash": "double-hyphen", "no-section-sign": "section-sign", "structural-controls": "structural",
};

// R6 stored-date-stated (V11) and R33 forward-events-covered: dates by the renderings of data/date-renderings.json, a day, a month or a year (dates only; no word matching, ADR-053).
const DATE_RENDERINGS = z.object({ register: z.array(z.string()), extra: z.array(z.string()) }).strict().parse(datesJson);
const ordinal = (d: number): string => (d % 100 >= 11 && d % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][d % 10] ?? "th"));
/** One ISO date (YYYY-MM-DD) in one rendering template (lower case: `stated` compares case-insensitively). */
function render(iso: string, template: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const month = MONTH_NAMES[m - 1] ?? "";
  const parts: Record<string, string> = { D: String(d), DD: String(d).padStart(2, "0"), MM: String(m).padStart(2, "0"), Month: month, Mon: month.slice(0, 3), YYYY: String(y), ord: ordinal(d) };
  return template.replace(/\{(\w+)\}/g, (_, k: string) => parts[k] ?? "");
}
export const REGISTER_RENDERINGS: readonly string[] = DATE_RENDERINGS.register;
export const stated = (body: string, iso: string, templates: readonly string[] = [...DATE_RENDERINGS.register, ...DATE_RENDERINGS.extra]): boolean => templates.some((t) => foldHtmlSpace(body).toLowerCase().includes(render(iso, t).toLowerCase()));
/** A date at its precision, as the key coverage compares: a day is YYYY-MM-DD, a month YYYY-MM (stored YYYY-MM-01), a year YYYY (stored YYYY-01-01). */
export const precisionKey = (date: string, precision?: string | null): string => (precision === "month" ? date.slice(0, 7) : precision === "year" ? date.slice(0, 4) : date.slice(0, 10));
/** A month or year key written in a section: "June 2031" or "Jun 2031" (a month), the year as a word (a year). A day key goes through the register renderings. */
const statedAtPrecision = (body: string, key: string): boolean => {
  const text = body.toLowerCase();
  if (key.length === 4) return new RegExp(`(^|[^0-9])${key}([^0-9]|$)`).test(text);
  const name = MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? "";
  return text.includes(`${name} ${key.slice(0, 4)}`) || text.includes(`${name.slice(0, 3)} ${key.slice(0, 4)}`);
};

// R13 accounting-line-present (V24): mirrors d and e of the item-briefs validator, moved here so the registry is their one owner.
const LARGE_POOL_CHARS = 200_000;
export const ACCOUNTING_RE = /Obligations surveyed:\s*(\d+);\s*workspace-adjacent:\s*(\d+);\s*extracted as FACT:\s*(\d+)\.?/i;
const SHORTFALL_RE = /^Shortfall:\s*\S.*$/im;
const NEGATION_RE = /\b(no(?!\.?\s*\d)|not|none|never|nor)\b/i; // "No 528/2012", "No. 1234" is an instrument number (also "Nos 1/2024"), not a negation
const NEGATION_WINDOW = 24;
// Small named stem lists with their inflections, matched on a claim's own verbatim span behind the negation guard.
const EXCEPTION_RE = /\b(exempt|exempts|exempted|exemption|exemptions|except|carve-?out|condition|conditions|conditional|subject to)\b/i;
const SCOPE_RE = /\b(scope|applies to|applies only|does not apply|limited to)\b/i;
const TRAJECTORY_RE = /\b(phase|phased|phase-in|per year|from \d{4})\b/i;
const CITE = "(?:articles?|sections?)\\s+[^.\\n]+";
const ABSENCE = { trajectory: new RegExp(`\\bno phase-in (?:is|are) stated in ${CITE}\\.`, "i"), exceptions: new RegExp(`\\bno exceptions? (?:is|are) stated in ${CITE}\\.`, "i"), scope: new RegExp(`\\bno scope limits? (?:is|are) stated in ${CITE}\\.`, "i") };
/** An unnegated hit of `re` in some claim's own span (a window of words before the match carries no negation). */
function unnegatedHit(claims: readonly BriefClaim[], re: RegExp): boolean {
  return claims.some((c) => {
    const span = c.span ?? "";
    const m = re.exec(span);
    return !!m && !NEGATION_RE.test(span.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index));
  });
}
const accountingLinePresent: Rule = (b, item) => {
  const key = FORMATS.find((f) => f.formatType === b.format)?.sections.find((s) => s.heading === "Substantive Requirements")?.key;
  const req = key ? b.sections.get(key) : undefined;
  const msgs: string[] = [];
  const at = (m: string) => void msgs.push(m);
  if (!req || !key) at('depth accounting: "Substantive Requirements" is not present (or has no extractable content) -- required for every regulatory_fact_document entry');
  else {
    const attached = b.claims.filter((c) => c.kind === "FACT" && c.section === key);
    const acc = ACCOUNTING_RE.exec(req);
    if (!acc) at('depth accounting: "Substantive Requirements" must end with the line "Obligations surveyed: N; workspace-adjacent: M; extracted as FACT: K." -- missing');
    else {
      const [adjacent, extracted] = [Number(acc[2]), Number(acc[3])];
      const shortfall = SHORTFALL_RE.test(req);
      if (extracted > attached.length) at(`depth accounting: "extracted as FACT: ${extracted}" overstates the ${attached.length} FACT claim(s) attached to section ${JSON.stringify(key)}`);
      if (extracted < adjacent && !shortfall) at(`depth accounting: "extracted as FACT: ${extracted}" is less than "workspace-adjacent: ${adjacent}" with no "Shortfall: <reason>" line`);
      if ((item.pool_chars ?? 0) > LARGE_POOL_CHARS && extracted < 5 && !shortfall) at(`depth accounting: source pool is ${item.pool_chars} chars (over ${LARGE_POOL_CHARS}) and "extracted as FACT: ${extracted}" is under 5 with no "Shortfall: <reason>" line`);
      const tail = req.slice(acc.index + acc[0].length).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !SHORTFALL_RE.test(l));
      if (tail.length) at(`depth accounting: content follows the accounting line inside "Substantive Requirements" (${JSON.stringify(tail[0])}${tail.length > 1 ? ", ..." : ""}) -- the accounting line (and any Shortfall line) must be the end of the section`);
    }
    if (!(item.has_trajectory || unnegatedHit(attached, TRAJECTORY_RE)) && !ABSENCE.trajectory.test(req)) at('qualification accounting: no per-year trajectory captured (metadata.requirement_trajectory or a FACT span) and no "No phase-in is stated in Article(s)/Section(s) <range>." note');
    if (!unnegatedHit(attached, EXCEPTION_RE) && !ABSENCE.exceptions.test(req)) at(`qualification accounting: no unnegated exception/carve-out keyword in the span of a FACT claim attached to section ${JSON.stringify(key)}, and no "No exceptions are stated in Article(s)/Section(s) <range>." note`);
    if (!unnegatedHit(attached, SCOPE_RE) && !ABSENCE.scope.test(req)) at(`qualification accounting: no unnegated scope-limit keyword in the span of a FACT claim attached to section ${JSON.stringify(key)}, and no "No scope limits are stated in Article(s)/Section(s) <range>." note`);
  }
  return msgs.length ? violation("accounting-line-present", msgs.join("; "), msgs[0] as string) : null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sectionsOf = (format: string) => FORMATS.find((f) => f.formatType === format)?.sections ?? [];
const headingBare = (h: string): string => normaliseHeading(h).replace(/^§\s*\d+\s*[.):-]*\s*/, "");
const BANNER_LABELS = new RegExp(LABELS.join("|"), "g");
const DO_NOW_LABEL = new RegExp(LABELS.join("|"));
const DO_NOW_LEAD = new RegExp(`^\\s*(?:[-*]\\s*)?(?:${LABELS.join("|")})\\s*:?\\s*`);
/** R34's normal form of a sentence: case, marks and spacing folded. */
const normSentence = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The required slot of the item types whose do-now section has no span to quote: its GAP claim IS the do-now section's lead action sentence (the slot's description says so; criterion 5 accepts it as the slot's cover). */
const DO_NOW_SLOT = "action_now";

const NAMES = z.object({ note: z.string(), max_words: z.number().int().min(1), hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1) }).strict().parse(namesJson);
const NAME_HASHES: ReadonlySet<string> = new Set(NAMES.hashes);
/**
 * Where the first workspace or client name is written in `text`, or -1. The names are held only as hashes (data/workspace-names.json, src/core/contracts/token-hash.ts): every run of 1 to max_words
 * consecutive words that opens on a word of 4 letters or more is hashed and looked up, case-insensitively. `hashes` is injectable so a test can plant a name of its own.
 */
function nameAt(text: string, hashes: ReadonlySet<string> = NAME_HASHES, maxWords: number = NAMES.max_words): number {
  const words = [...text.matchAll(/[a-z]+/gi)];
  for (const [i, w] of words.entries()) {
    if (w[0].length < 4) continue;
    for (let n = 1; n <= maxWords && i + n <= words.length; n++) if (hashes.has(tokenHash(words.slice(i, i + n).map((x) => x[0]).join(" ")))) return w.index;
  }
  return -1;
}
/** The parts of an organization name (split on the slash) whose hash the name list lacks: the report fails when there is one. */
export const namesLacking = (organizationNames: readonly string[], hashes: ReadonlySet<string> = NAME_HASHES): string[] =>
  organizationNames.flatMap((o) => o.split("/").map((n) => n.trim().replace(/\s+/g, " "))).filter((n) => n && !hashes.has(tokenHash(n))).map((n) => tokenHash(n));

/** The rule functions by registry id (data/rules.json); workspace-or-client-named is R2 (V02): the workspace or a named client is written in the brief, the names held as hashes, never in clear. */
export const RULES: Readonly<Record<string, Rule>> = {
  ...Object.fromEntries(Object.entries(TEXT_RULES).map(([id, key]) => [id, textRule(id, key)])),
  // R14 (V18): no claim-ledger JSON key and no internal marker in the body (findInternalMarkers: sentinels, the ledger name, a JSON object literal) plus the ledger's own keys.
  "no-claim-ledger-json": (() => {
    const keys = textRule("no-claim-ledger-json", "claim-ledger");
    return (b, i) => {
      const markers = findInternalMarkers(b.body);
      return markers.length ? violation("no-claim-ledger-json", describeMarkers(markers), markers[0]?.excerpt ?? "") : keys(b, i);
    };
  })(),
  // R16 (V34): a FACT span is verbatim in its attributed capture (the item pool for a batch entry, the claim's search result for a stored row): the batch-time refusal of what the ground step would drop.
  "fact-span-in-capture": (b) => {
    const msgs: string[] = [];
    b.claims.forEach((c, ci) => {
      if (c.kind !== "FACT" || !c.span?.trim()) return;
      try {
        assertVerbatim(c.capture, c.span);
      } catch (e) {
        msgs.push(`claims[${ci}]: source_span is not a verbatim substring of the item's pool text (${(e as Error).message})`);
      }
    });
    return msgs.length ? violation("fact-span-in-capture", msgs.join("; "), msgs[0] as string) : null;
  },
  // R8 (V21): a claim's declared section is a key of the format and, for a FACT, holds the claim's span (mirror f of the item-briefs validator).
  "fact-span-in-own-section": (b) => {
    const keys = new Set(sectionsOf(b.format).map((s) => s.key));
    const msgs: string[] = [];
    b.claims.forEach((c, ci) => {
      if (!c.section) return;
      if (!keys.has(c.section)) msgs.push(`claims[${ci}]: section ${JSON.stringify(c.section)} is not a canonical section key for format_type ${JSON.stringify(b.format)} (valid: ${JSON.stringify([...keys])})`);
      else if (c.kind === "FACT" && c.span?.trim() && !isVerbatim(b.sections.get(c.section), c.span)) msgs.push(`claims[${ci}]: source_span is not present in section ${JSON.stringify(c.section)}'s own extracted text -- a claim's declared section must contain the sentence its source_span comes from`);
    });
    return msgs.length ? violation("fact-span-in-own-section", msgs.join("; "), msgs[0] as string) : null;
  },
  "accounting-line-present": accountingLinePresent,
  // R6 (V11): each stored entry_into_force and compliance_deadline is written in the body in one of the accepted renderings.
  "stored-date-stated": (b, i) => {
    const missing = (["entry_into_force", "compliance_deadline"] as const).filter((k) => i[k] && !stated(b.body, i[k] as string));
    return missing.length ? violation("stored-date-stated", missing.map((k) => `${k} ${String(i[k])} is never written in the body`).join("; "), "") : null;
  },
  // R33: the coverage half of the no-vacuum rule (J17 keeps the interpretive half): every dated forward event and timeline row the export supplied appears in the events block, a section, or omitted_events with a reason.
  "forward-events-covered": (b, i) => {
    const supplied = [...new Set((i.supplied_dates ?? []).map((d) => (d.length >= 10 ? d.slice(0, 10) : d)))];
    const events = new Set(b.events ?? []);
    const omitted = (b.omitted ?? []).filter((o) => o.reason.trim()).map((o) => o.date);
    const missing = supplied.filter((d) => !events.has(d) && !omitted.some((o) => o.startsWith(d)) && !(d.length === 10 ? stated(b.body, d) : statedAtPrecision(b.body, d)));
    return missing.length ? violation("forward-events-covered", `${missing.length} supplied forward event or timeline date(s) never appear in the brief (events block, a section, or omitted_events with a reason): ${missing.slice(0, 6).join(", ")}`, "") : null;
  },
  // R9 (V08): each do-now section the brief has (regulatory 3 and 11, technology 7, market 7) carries one of the five severity labels.
  "do-now-severity-label": (b) => {
    const bare = sectionWithRole(b.format, "do_now").map((s) => s.key).filter((k) => b.sections.has(k) && !DO_NOW_LABEL.test(b.sections.get(k) as string));
    return bare.length ? violation("do-now-severity-label", `do-now section ${bare.join(", ")} carries no severity label (${LABELS.join(", ")})`, b.sections.get(bare[0] as string) as string) : null;
  },
  // R34: a do-now sentence that only restates a GAP claim of the same brief is gap narration written as an action; the gap belongs in the gaps. The GAP claim that answers the action_now slot is the one exception: its claim_text IS the lead action sentence.
  "do-now-restates-gap": (b) => {
    const gaps = new Set(b.claims.filter((c) => c.kind === "GAP" && !c.text.toLowerCase().includes(DO_NOW_SLOT)).map((c) => normSentence(c.text.replace(/^\s*\[[^\]]*\]\s*/, ""))).filter(Boolean));
    if (!gaps.size) return null;
    for (const { key } of sectionWithRole(b.format, "do_now")) {
      for (const line of (b.sections.get(key) ?? "").split(/(?<=[.!?])\s+|\n+/)) {
        if (gaps.has(normSentence(line.replace(DO_NOW_LEAD, "")))) return violation("do-now-restates-gap", `do-now section ${key} restates a gap as an action`, line.trim());
      }
    }
    return null;
  },
  // R10 (V30): sources_used holds at least one source id.
  "sources-used-non-empty": (_b, i) => (i.sources_used.some((s) => UUID.test(s)) ? null : violation("sources-used-non-empty", "sources_used holds no source id", "")),
  // R12 (V19): every non-conditional section of the format has a row. An omission note is no row.
  "required-sections-present": (b) => {
    const missing = sectionsOf(b.format).filter((s) => !s.conditional && !b.sections.has(s.key)).map((s) => s.key);
    return missing.length ? violation("required-sections-present", `${b.format} has no section ${missing.join(", ")}`, missing.join(", ")) : null;
  },
  // R7 (V28): what_it_changes is present and within the contract's character window (data/rule-patterns.json limits).
  "what-it-changes-length": (_b, i) => {
    const { min = 0, max = Infinity } = limitOf("what_it_changes");
    const n = i.what_it_changes?.length ?? null;
    return n !== null && n >= min && n <= max ? null : violation("what-it-changes-length", n === null ? "what_it_changes is null" : `what_it_changes is ${n} characters, outside ${min} to ${max}`, i.what_it_changes ?? "");
  },
  // R18 (V05): severity is set on the four formats whose skill makes it mandatory (the registry row names them).
  "severity-present": (b, i) => (i.severity === null ? violation("severity-present", `severity is null on a ${b.format}`, "") : null),
  // R19 (V06): the priority is the locked map's priority for the severity token.
  "priority-follows-map": (_b, i) => {
    const want = i.severity === null ? undefined : PRIORITY_OF[i.severity];
    return want === undefined || want === i.priority ? null : violation("priority-follows-map", `severity ${i.severity} locks priority ${want}, the column holds ${String(i.priority)}`, String(i.priority));
  },
  // R20 (V07): the SET of severity labels in the banner (the first 600 characters) equals the label of the severity token; a body with no banner passes.
  "banner-matches-column": (b, i) => {
    const head = b.body.slice(0, limitOf("banner").window ?? 600);
    const found = [...new Set(head.match(BANNER_LABELS) ?? [])];
    const want = i.severity === null ? undefined : LABEL_OF[i.severity];
    return found.length === 0 || (found.length === 1 && found[0] === want) ? null : violation("banner-matches-column", `banner ${found.join(" | ")} against severity ${String(i.severity)}`, head);
  },
  // R22 (V14): no URL in the prose outside the Sources section and the citation lines the renderer consumes (*Source: ... lines).
  "no-bare-url-in-prose": (() => {
    const [url, sources, cite] = [patternsOf("url")[0] as RegExp, patternsOf("sources-section")[0] as RegExp, patternsOf("source-line")[0] as RegExp];
    return (b) => {
      const text = b.body.replace(sources, "").split("\n").filter((l) => !cite.test(l)).join("\n");
      const m = url.exec(text);
      return m ? violation("no-bare-url-in-prose", `URL in prose: ${m[0].slice(0, 60)}`, text.slice(Math.max(0, m.index - 20))) : null;
    };
  })(),
  // R25 (V20): after the title, an H1 is a heading or heading alternate of the format, compared case-insensitively after the title numbering is stripped (no -ize/-ise folding: a British-spelled heading is named).
  "h1-in-section-list": (b) => {
    const known = sectionsOf(b.format).flatMap((s) => [s.heading, ...(s.headingAlts ?? [])]);
    const stray = [...b.body.matchAll(/^#\s+(.+?)\s*#*\s*$/gm)].slice(1).map((m) => m[1] ?? "").find((h) => !known.some((k) => headingBare(h).toLowerCase() === normaliseHeading(k).toLowerCase()));
    return stray === undefined ? null : violation("h1-in-section-list", `H1 ${JSON.stringify(stray)} is not a section of ${b.format}`, stray);
  },
  // R27 (V27): why_matters and what_is_it are not null or blank.
  "summary-fields-non-blank": (_b, i) => {
    const blank = (["why_matters", "what_is_it"] as const).filter((k) => !i[k]?.trim());
    return blank.length ? violation("summary-fields-non-blank", `${blank.join(" and ")} blank`, "") : null;
  },
  // R29 (V31): a market signal brief carries its signal_band and a research summary its theme.
  "band-or-theme-present": (b, i) => {
    const field = b.format === "market_signal_brief" ? "signal_band" : "theme";
    return i[field] ? null : violation("band-or-theme-present", `${field} is missing on a ${b.format}`, "");
  },
  "workspace-or-client-named": (b) => {
    const at = nameAt(b.body);
    return at < 0 ? null : violation("workspace-or-client-named", "a workspace or client name is written in the brief", b.body.slice(Math.max(0, at - 20)));
  },
  // R35: section 8 of a regulatory fact document carries the legal callout (LEGAL_CALLOUT followed by non-empty text): the obligations there name the question for counsel (J13).
  "section-8-legal-callout": (b) => {
    const s = b.sections.get("8");
    if (s === undefined) return null;
    const at = s.indexOf(LEGAL_CALLOUT);
    return at >= 0 && s.slice(at + LEGAL_CALLOUT.length).trim() !== "" ? null : violation("section-8-legal-callout", `section 8 carries no ${LEGAL_CALLOUT} line naming the question for counsel`, s);
  },
};

const row = z.object({ id: z.string(), severity: z.enum(["refuse", "residue"]), applies_to: z.array(z.enum(FORMAT_TYPES as [string, ...string[]])).min(1), scope: z.enum(["prose", "whole"]) }).strict();
export type RuleRow = z.infer<typeof row>;
export const REGISTRY: readonly RuleRow[] = z.array(row).min(1).parse(rulesJson);

/** A rule function with no registry row, or a row with no rule function, fails the import. */
export function assertRegistry(ids: readonly string[], rows: readonly RuleRow[]): void {
  for (const id of ids) if (!rows.some((r) => r.id === id)) throw new Error(`brief rules: ${id} has a rule file and no row in data/rules.json`);
  for (const r of rows) if (!ids.includes(r.id)) throw new Error(`brief rules: data/rules.json names ${r.id} and no rule file holds it`);
}
assertRegistry(Object.keys(RULES), REGISTRY);

/** Run one registered rule: over the prose view or the whole body as its row says (`whole` forces the whole body, the form the register's counts were taken in). */
export function runRule(r: RuleRow, brief: BriefModel, item: ItemColumns, whole = false): Violation | null {
  return (RULES[r.id] as Rule)(r.scope === "prose" && !whole ? { ...brief, body: proseOf(brief) } : brief, item);
}

/**
 * validateBrief(brief, item): every registered rule whose row names the brief's format, run over the brief and the item's columns. `refuse` violations make a claim false or expose internals and block the apply;
 * `residue` violations route the brief to residue with the rule id named. The registry row is the one owner of each rule's severity.
 */
export function validateBrief(brief: BriefModel, item: ItemColumns): { refuse: Violation[]; residue: Violation[] } {
  const out: { refuse: Violation[]; residue: Violation[] } = { refuse: [], residue: [] };
  for (const r of REGISTRY) {
    const v = r.applies_to.includes(brief.format) ? runRule(r, brief, item) : null;
    if (v) out[r.severity].push(v);
  }
  return out;
}
