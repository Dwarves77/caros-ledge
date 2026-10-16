// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 101-330)
// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 548-1051)
// The record-briefs validator: one entry (a full brief, its metadata and its claim ledger) checked against the item's LIVE pool before any write. The eight mirrors refuse what the ground step would quarantine,
// naming the exact token or section: Gate A (a figure or date no FACT covers), criterion 4 (an unlabelled requirement), the per-format timeline, claim-section attachment, depth accounting, qualification accounting,
// the numeric figure (decimals kept), and criterion 5 (a required slot without a covering FACT or, where its description allows, GAP). Section boundaries come from the REAL format registry
// (core/brief FORMAT_SPECS), so the old second copy of the section list and its drift test are gone. Pure: the caller supplies the live material.
import { ANALYSIS_LABELS, buildTimelineRows, checkBriefContent, findInternalMarkers, findTimelineSection, FORMAT_SPECS, LEGAL_CALLOUT, parseTimeline, validateClaimRecords, validateMetadata, type AdoptedTerms, type SectionRow } from "@/core/brief";
import { describeMarkers } from "@/core/brief/sections";
import { assertVerbatim } from "@/core/contracts/verbatim";
import { scanGateA, uncoveredSlots, type SlotRow } from "@/core/grounding";

import { poolHashError, type EntryResult, isObj, nonEmpty, type Obj } from "../../kit/session-batch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECORD_BRIEFS_SCHEMA_VERSION = "rb2-2026-10-17.1";
export const MIN_BODY_CHARS = 600;
const LARGE_POOL_CHARS = 200_000;

const LABEL_RE = new RegExp(`\\*?(${ANALYSIS_LABELS.join("|")})(\\s*\\([^)]*\\))?:\\*?`, "i");
const MODAL_RE = /\b(requires|must|mandates|obligates|prohibits|applies to)\b/i;
const ACCOUNTING_RE = /Obligations surveyed:\s*(\d+);\s*workspace-adjacent:\s*(\d+);\s*extracted as FACT:\s*(\d+)\.?/i;
const SHORTFALL_RE = /^Shortfall:\s*\S.*$/im;
const NEGATION_RE = /\b(no|not|none|never|nor)\b/i;
const NEGATION_WINDOW = 24;
// Small named stem lists with their inflections, matched on a claim's own verbatim span behind the negation guard.
const EXCEPTION_RE = /\b(exempt|exempts|exempted|exemption|exemptions|except|carve-?out|condition|conditions|conditional|subject to)\b/i;
const SCOPE_RE = /\b(scope|applies to|applies only|does not apply|limited to)\b/i;
const TRAJECTORY_RE = /\b(phase|phased|phase-in|per year|from \d{4})\b/i;
const CITE = "(?:articles?|sections?)\\s+[^.\\n]+";
const ABSENCE = { trajectory: new RegExp(`\\bno phase-in (?:is|are) stated in ${CITE}\\.`, "i"), exceptions: new RegExp(`\\bno exceptions? (?:is|are) stated in ${CITE}\\.`, "i"), scope: new RegExp(`\\bno scope limits? (?:is|are) stated in ${CITE}\\.`, "i") };

// The numeric-figure mirror keeps the decimal point (the mint-time soft gate strips it, which would false-positive a correctly cited "3.5%" in a HARD refusal) and ignores provenance pointers: the leading slot tag, a legal locator.
const NUMERIC_RE = /(?:[$€£]|EUR|USD|GBP)?\s?\d[\d,]*(?:\.\d+)?\s?%?/gi;
const NUM = String.raw`\d+(?:[./-]\d+)*(?:\s*\(\d+\))*(?:\s*\([a-z]\))?(?:[a-z](?![a-z]))?`;
const NUM_LIST = `${NUM}(?:\\s*(?:,|and|to|or|&)\\s*${NUM})*`;
const LOCATOR_RE = new RegExp(String.raw`\b(?:sections?|secs?\.|ss\.|s\.|articles?|arts?\.|regulations?|regs?\.|directives?|decisions?|parts?|schedules?|annex(?:es)?|chapters?|rules?|paragraphs?|paras?\.|points?|entr(?:y|ies)|clauses?|recitals?|subparts?|targets?|goals?|indicators?|SDGs?)\s*(?:\((?:EU|EC|EEC)\)\s*)?(?:No\.?\s*)?${NUM_LIST}`, "gi");
const POINTERS: readonly RegExp[] = [
  /^\s*\[[a-z][a-z0-9_-]*\]\s*/i,
  LOCATOR_RE,
  /\b(?:19|20)\d{2}(?:\s+[A-Z][A-Za-z-]*){0,3}\s+(?:Regulations|Act|Order|Rules|Scheme|[Ii]nstruments?|Strategy|Plan|Programme|Program|Policy|Framework|Guidelines?|Standard|Roadmap|Agreement|Protocol|Directive|Regulation|Decision|[A-Z]{2,6})\b/g,
  /\b\d{1,2}\s+(?:CFR|C\.F\.R\.|CRR-NY|NYCRR|USC|U\.S\.C\.)\b/g,
  /\b[A-Z][A-Za-z]*-\d+[A-Za-z]?\b/g,
];
const normalizeFigure = (t: string): string => t.replace(/[$€£%]|EUR|USD|GBP/gi, "").replace(/[\s,]/g, "");
/** Significant figures: two or more digits, a dotted date split into its parts first. */
function figuresIn(text: string): string[] {
  return [...String(text ?? "").replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/g, "$1 $2 $3").matchAll(NUMERIC_RE)].map((m) => m[0].trim()).filter((t) => normalizeFigure(t).replace(/\./g, "").length >= 2);
}
/** claim_text with the provenance pointers removed: what the numeric mirror measures against the span. */
export const figureCheckText = (claimText: string): string => POINTERS.reduce((t, re) => t.replace(re, " "), String(claimText ?? ""));

/** An unnegated hit of `re` in some claim's own span (a window of words before the match carries no negation). */
function unnegatedHit(claims: readonly Obj[], re: RegExp): boolean {
  return claims.some((c) => {
    const span = String(c.source_span ?? "");
    const m = re.exec(span);
    return !!m && !NEGATION_RE.test(span.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index));
  });
}

/** Does this slot's description name a GAP claim form? The descriptions are the policy source: a description without one is a HARD slot (a FACT only). */
export function slotAllowsGap(slot: SlotRow): boolean {
  const d = String(slot?.description ?? "");
  return /claim_kind\s*=\s*GAP/i.test(d) || /\bGAP claim\b/i.test(d) || /\bGAP\s+(acceptable|accepted|allowed|permitted|when|where|if)\b/i.test(d) || /\bemit a GAP\b/i.test(d);
}

/** Criterion 5: per required slot, a FACT (or a GAP where the description allows one) whose claim_text names the slot key. */
export function requiredSlotErrors(claims: readonly Obj[], slots: readonly SlotRow[], tag: string, itemType: string): string[] {
  const errors: string[] = [];
  for (const slot of slots) {
    const key = slot.slot_key.toLowerCase();
    const mentions = claims.filter((c) => typeof c.claim_text === "string" && c.claim_text.toLowerCase().includes(key));
    const gapOk = slotAllowsGap(slot);
    if (mentions.some((c) => c.claim_kind === "FACT") || (gapOk && mentions.some((c) => c.claim_kind === "GAP"))) continue;
    errors.push(mentions.some((c) => c.claim_kind === "GAP") && !gapOk
      ? `${tag}: required slot "${key}" for item_type ${itemType} is covered only by a GAP claim, and the slot's description names no GAP form (a binding-law slot stays HARD); emit a FACT claim whose claim_text names "${key}" with a verbatim source_span`
      : `${tag}: required slot "${key}" for item_type ${itemType} has no covering claim (criterion 5 needs a FACT${gapOk ? " or GAP" : ""} claim whose claim_text names "${key}"); the ground step would quarantine this item with missing_required_slot`);
  }
  return errors;
}

export interface RecordItemLive { itemType: string; grade: string | null; status: string | null; hash: string; poolText: string; bytes: number; fullBrief: string | null }
export interface RecordLive { items: Map<string, RecordItemLive>; slots: Map<string, SlotRow[]>; adopted: AdoptedTerms; now: Date; allowOverwrite: boolean }
export interface RecordPlan { itemId: string; bytes: number; claims: Obj[] }

const norm = (s: string): string => s.toLowerCase();

/** Validate ONE entry: every message names the item and the offending field or claim index. */
export function validateRecordBriefEntry(entry: unknown, i: number, live: RecordLive): EntryResult<RecordPlan> {
  if (!isObj(entry)) return { errors: [`entries[${i}]: must be an object`] };
  const itemId = nonEmpty(entry.item_id) ? entry.item_id : `entries[${i}]`;
  const tag = `item ${itemId}`;
  const errors: string[] = [];
  const at = (msg: string) => void errors.push(`${tag}: ${msg}`);
  if (!nonEmpty(entry.item_id) || !UUID_RE.test(entry.item_id)) return { errors: [`${tag}: item_id must be a UUID`] };
  const item = live.items.get(entry.item_id);
  if (!item) return { errors: [`${tag}: item not found`] };
  const stale = poolHashError(tag, entry.source_pool_hash, item.hash);
  if (stale) return { errors: [stale] };
  if (item.grade !== "record" && !live.allowOverwrite) return { errors: [`${tag}: item_grade is '${item.grade ?? "brief"}', not 'record': an existing brief is regenerated only with allowBriefOverwrite`] };
  const body = typeof entry.body === "string" ? entry.body : "";
  if (body.trim() === "") at("body must be a non-empty string");
  else {
    if (body.trim().length < MIN_BODY_CHARS) at(`body is ${body.trim().length} characters, under the ${MIN_BODY_CHARS} the brief write requires`);
    const content = checkBriefContent(body);
    if (!content.ok) at(`brief failure gate: ${content.reason}`);
    const markers = findInternalMarkers(body);
    if (markers.length) at(`internal marker in the body: ${describeMarkers(markers)}`);
    const unaddressed = uncoveredSlots(body, live.slots.get(item.itemType) ?? []);
    if (unaddressed.length) at(`the body leaves ${unaddressed.length} required slot(s) silently unaddressed (${unaddressed.map((x) => x.slot_key).join(", ")}): state each as a cited FACT or an explicit GAP`);
  }
  const meta = validateMetadata(entry.metadata, { adopted: live.adopted, now: live.now });
  if (!meta.ok) for (const e of meta.errors) at(`metadata: ${e}`);
  const formatType = meta.ok ? meta.value.format_type : isObj(entry.metadata) ? String(entry.metadata.format_type ?? "") : "";
  const spec = FORMAT_SPECS.find((s) => s.formatType === formatType) ?? null;
  if (meta.ok && !spec) at(`format_type ${JSON.stringify(formatType)} has no section list`);
  else if (spec && !spec.itemTypes.includes(item.itemType)) at(`format_type ${formatType} is not the format of item_type ${item.itemType}`);

  // claims: the basic shape through the one claim validator, then section, verbatim and the numeric mirror.
  const rawClaims = Array.isArray(entry.claims) ? (entry.claims as unknown[]) : null;
  if (!rawClaims) at("claims must be an array");
  const claims: Obj[] = (rawClaims ?? []).filter(isObj);
  if (rawClaims) {
    const basic = validateClaimRecords(rawClaims);
    for (const e of basic.errors) at(`claims: ${e}`);
    claims.forEach((c, ci) => {
      const cat = (msg: string) => void errors.push(`${tag} claims[${ci}]: ${msg}`);
      if (!nonEmpty(c.section)) cat('section must be a non-empty string (the canonical section key of the entry\'s format_type, e.g. "8" for Substantive Requirements)');
      if (c.claim_kind !== "FACT" || !nonEmpty(c.source_span)) return;
      try {
        assertVerbatim(item.poolText, c.source_span);
      } catch (e) {
        cat(`source_span is not a verbatim substring of the item's pool text (${(e as Error).message})`);
      }
      const spanFigures = new Set(figuresIn(c.source_span).map(normalizeFigure));
      for (const figure of figuresIn(figureCheckText(String(c.claim_text ?? "")))) {
        if (!spanFigures.has(normalizeFigure(figure))) cat(`claim_text figure ${JSON.stringify(figure)} does not appear in this claim's own source_span (numeric-figure mirror) -- cite the figure as it appears in the source, or drop it from claim_text`);
      }
    });
  }
  const sections: SectionRow[] = spec && body ? spec.extract(body) : [];
  const textByKey = new Map(sections.map((s) => [s.section_key, s.content_md]));

  // MIRROR f: a claim's declared section is a key of the format and contains the claim's span.
  if (spec) {
    const keys = new Set(spec.sections.map((s) => s.key));
    claims.forEach((c, ci) => {
      if (!nonEmpty(c.section)) return;
      const cat = (msg: string) => void errors.push(`${tag} claims[${ci}]: ${msg}`);
      if (!keys.has(c.section)) cat(`section ${JSON.stringify(c.section)} is not a canonical section key for format_type ${JSON.stringify(formatType)} (valid: ${JSON.stringify([...keys])})`);
      else if (nonEmpty(c.source_span) && !norm(textByKey.get(c.section) ?? "").includes(norm(c.source_span))) cat(`source_span is not present in section ${JSON.stringify(c.section)}'s own extracted text -- a claim's declared section must contain the sentence its source_span comes from`);
    });
  }
  // MIRROR a: Gate A, the literal arm: every figure or date in the body is inside a FACT claim's text or span, or not written at all.
  if (body) {
    const gate = scanGateA(body, claims.filter((c) => c.claim_kind === "FACT").map((c) => ({ claim_text: String(c.claim_text ?? ""), source_span: String(c.source_span ?? "") })));
    if (gate.orphan_count > 0) at(`Gate A mirror: ${gate.orphan_count} orphan token(s) in the body with no covering FACT claim: ${gate.orphans.map((o) => `${JSON.stringify(o.token)} (${o.class})`).join(", ")}. Add a FACT claim whose claim_text or source_span carries the token verbatim, or remove the token from the body.`);
  }
  // MIRROR b: criterion 4, stricter than the database in one way: a FACT attached to the section does not stand in for a label (attachment is only known at the write site).
  for (const s of sections) {
    if (MODAL_RE.test(s.content_md) && !(LABEL_RE.test(s.content_md) || norm(s.content_md).includes(norm(LEGAL_CALLOUT)))) at(`criterion 4 mirror: unlabeled assertion in section ${JSON.stringify(s.section_key)} -- matches /requires|must|mandates|obligates|prohibits|applies to/i with no analysis label and no ${LEGAL_CALLOUT} callout in that section.`);
  }
  // MIRROR c: the format's own timeline section yields at least one dated row ("no item without a date in its timeline").
  const timelineDef = spec?.sections.find((s) => s.roles?.includes("timeline"));
  if (spec && timelineDef && body) {
    const found = findTimelineSection(body, formatType);
    if (!found) at(`timeline mirror: body has no ${JSON.stringify(timelineDef.heading)} section (the instrument's own adoption, publication or entry-into-force date qualifies when no other dated milestone exists)`);
    else {
      const entries = parseTimeline(found.contentMarkdown);
      const { rows, skipped } = buildTimelineRows(entries, "1970-01-01");
      if (rows.length === 0) at(`timeline mirror: the ${JSON.stringify(timelineDef.heading)} section yields ZERO rows once parsed (${entries.length} raw entr${entries.length === 1 ? "y" : "ies"}, ${skipped.length} skipped as unparseable: ${JSON.stringify(skipped)})`);
    }
  }
  // MIRRORS d and e: regulatory_fact_document only. Depth accounting ends the Substantive Requirements section; each qualification is captured by a FACT claim of that section or recorded absent with a citing sentence.
  const reqKey = spec?.sections.find((s) => s.heading === "Substantive Requirements")?.key;
  if (formatType === "regulatory_fact_document" && body) {
    const req = reqKey ? textByKey.get(reqKey) : undefined;
    if (!req || !reqKey) at('depth accounting: "Substantive Requirements" is not present (or has no extractable content) -- required for every regulatory_fact_document entry');
    else {
      const attached = claims.filter((c) => c.claim_kind === "FACT" && String(c.section) === reqKey);
      const acc = ACCOUNTING_RE.exec(req);
      if (!acc) at('depth accounting: "Substantive Requirements" must end with the line "Obligations surveyed: N; workspace-adjacent: M; extracted as FACT: K." -- missing');
      else {
        const [adjacent, extracted] = [Number(acc[2]), Number(acc[3])];
        const shortfall = SHORTFALL_RE.test(req);
        if (extracted > attached.length) at(`depth accounting: "extracted as FACT: ${extracted}" overstates the ${attached.length} FACT claim(s) attached to section ${JSON.stringify(reqKey)}`);
        if (extracted < adjacent && !shortfall) at(`depth accounting: "extracted as FACT: ${extracted}" is less than "workspace-adjacent: ${adjacent}" with no "Shortfall: <reason>" line`);
        if (item.poolText.length > LARGE_POOL_CHARS && extracted < 5 && !shortfall) at(`depth accounting: source pool is ${item.poolText.length} chars (over ${LARGE_POOL_CHARS}) and "extracted as FACT: ${extracted}" is under 5 with no "Shortfall: <reason>" line`);
        const tail = req.slice(acc.index + acc[0].length).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !SHORTFALL_RE.test(l));
        if (tail.length) at(`depth accounting: content follows the accounting line inside "Substantive Requirements" (${JSON.stringify(tail[0])}${tail.length > 1 ? ", ..." : ""}) -- the accounting line (and any Shortfall line) must be the end of the section`);
      }
      const trajectory = meta.ok && meta.value.requirement_trajectory !== null;
      if (!(trajectory || unnegatedHit(attached, TRAJECTORY_RE)) && !ABSENCE.trajectory.test(req)) at('qualification accounting: no per-year trajectory captured (metadata.requirement_trajectory or a FACT span) and no "No phase-in is stated in Article(s)/Section(s) <range>." note');
      if (!unnegatedHit(attached, EXCEPTION_RE) && !ABSENCE.exceptions.test(req)) at(`qualification accounting: no unnegated exception/carve-out keyword in the span of a FACT claim attached to section ${JSON.stringify(reqKey)}, and no "No exceptions are stated in Article(s)/Section(s) <range>." note`);
      if (!unnegatedHit(attached, SCOPE_RE) && !ABSENCE.scope.test(req)) at(`qualification accounting: no unnegated scope-limit keyword in the span of a FACT claim attached to section ${JSON.stringify(reqKey)}, and no "No scope limits are stated in Article(s)/Section(s) <range>." note`);
    }
  }
  // MIRROR 8: criterion 5.
  errors.push(...requiredSlotErrors(claims, live.slots.get(item.itemType) ?? [], tag, item.itemType));
  return errors.length ? { errors } : { errors, plan: { itemId: entry.item_id, bytes: item.bytes, claims } };
}
