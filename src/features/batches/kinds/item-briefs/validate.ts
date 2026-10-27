// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 101-330)
// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 548-1051)
// The item-briefs validator: one entry (a full brief, its metadata and its claim ledger) checked against the item's LIVE pool before any write. The eight mirrors refuse what the ground step would quarantine,
// naming the exact token or section: Gate A (a figure or date no FACT covers), criterion 4 (an unlabelled requirement), the per-format timeline, claim-section attachment, depth accounting, qualification accounting,
// the numeric figure (decimals kept), and criterion 5 (a required slot without a covering FACT or, where its description allows, GAP). Section boundaries come from the REAL format registry
// (core/brief FORMAT_SPECS), so the old second copy of the section list and its drift test are gone. Pure: the caller supplies the live material.
import { analysisLabelRe, buildTimelineRows, checkBriefContent, findTimelineSection, FORMAT_SPECS, LEGAL_CALLOUT, MODAL_RE, parseTimeline, validateClaimRecords, validateMetadata, type AdoptedTerms, type BriefMetadata, type SectionRow } from "@/core/brief";
import { severityToken, validateBrief, type ItemColumns } from "@/core/brief/rules";
import { precisionKey } from "@/core/brief/rules/forward-events-covered";
import { scanGateA, uncoveredSlots, type SlotRow } from "@/core/grounding";
import { digestKind } from "@/core/digest/kinds";
import { review } from "@/core/digest/review";

import { poolHashError, type EntryResult, isObj, nonEmpty, type Obj } from "../../kit/session-batch";

import { validateEmission, type EmissionPlan, type EmitLive } from "./emission";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_BODY_CHARS = 600;

const LABEL_RE = analysisLabelRe();
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
const figureCheckText = (claimText: string): string => POINTERS.reduce((t, re) => t.replace(re, " "), String(claimText ?? ""));

/** Does this slot's description name a GAP claim form? The descriptions are the policy source: a description without one is a HARD slot (a FACT only). */
function slotAllowsGap(slot: SlotRow): boolean {
  const d = String(slot?.description ?? "");
  return /claim_kind\s*=\s*GAP/i.test(d) || /\bGAP claim\b/i.test(d) || /\bGAP\s+(acceptable|accepted|allowed|permitted|when|where|if)\b/i.test(d) || /\bemit a GAP\b/i.test(d);
}

/** Criterion 5: per required slot, a FACT (or a GAP where the description allows one) whose claim_text names the slot key. */
function requiredSlotErrors(claims: readonly Obj[], slots: readonly SlotRow[], tag: string, itemType: string): string[] {
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

export interface RecordItemLive { /** The stored sections derive from the stored brief (DRAIN-FIX-2 R2): an applied item whose sections do not is half applied and runs again. */ sectionsOk?: boolean; /** GROUND-FIX-1: the stored ledger claims; an applied item whose ledger lacks the entry's claims is half applied and runs again. */ claims?: readonly { claim_text: string; source_span: string | null; section_row_id: string | null }[]; sections?: readonly { id: string; section_key: string; section_order: number }[]; itemType: string; grade: string | null; status: string | null; hash: string; poolText: string; bytes: number; fullBrief: string | null; entryIntoForce: string | null; complianceDeadline: string | null; /** ISO dates of the item's forward events and timeline rows (the export's forward_events and timelines). */ suppliedDates?: readonly string[] }
export interface RecordLive { items: Map<string, RecordItemLive>; slots: Map<string, SlotRow[]>; adopted: AdoptedTerms; now: Date; allowOverwrite: boolean; /** The live material of the entries that carry typed blocks (DIGEST-1 PR B), by item. */ emit: ReadonlyMap<string, EmitLive> }
export interface RecordPlan { itemId: string; bytes: number; claims: Obj[]; emission: EmissionPlan | null; /** EMIT-ON-RESIDUE: the blocks a residue entry does not write, each with why (its own judge failed, or the kind does not emit it on residue). */ skipped?: string[] }

/** EMIT-ON-RESIDUE: what a residue entry (valid emission, prose held back) may still write. A block whose OWN judge failed is not written: J20 failed skips the connections, J18 failed skips the entity_ids (the joins that make spurious patterns). J19 does not block obligation_fields. New-entity candidates are proposals about the prose and wait with it. */
export function residueEmission(entry: Obj, plan: EmissionPlan): { emission: EmissionPlan; skipped: string[] } {
  const failed = new Set(review("item-briefs", entry).failed);
  const skipped: string[] = [];
  const out: EmissionPlan = { ...plan };
  if (plan.connections.length && failed.has("J20")) { out.connections = []; skipped.push("connections (J20 failed)"); }
  if (plan.entities.length && failed.has("J18")) { out.entities = []; skipped.push("entity_ids (J18 failed)"); }
  if (plan.candidates.length) { out.candidates = []; skipped.push("new_entity_candidates (wait with the prose)"); }
  return { emission: out, skipped };
}

const norm = (s: string): string => s.toLowerCase();

/** The item columns the brief rules read: the entry's metadata (severity as an ADR-052 token) and the live item's stored dates. */
const columns = (m: BriefMetadata | null, item: RecordItemLive, formatType: string): ItemColumns => ({
  severity: severityToken(m?.severity), priority: m?.priority ?? null, urgency_tier: m?.urgency_tier ?? null, entry_into_force: item.entryIntoForce ?? null, compliance_deadline: item.complianceDeadline ?? null,
  what_it_changes: m?.what_it_changes ?? null, what_is_it: m?.what_is_it ?? null, why_matters: m?.why_matters ?? null, topic_tags: m?.topic_tags ?? [], sources_used: m?.sources_used ?? [],
  signal_band: m?.signal_band ?? null, theme: m?.theme ?? null, format_type: formatType, pool_chars: item.poolText.length, has_trajectory: !!m?.requirement_trajectory, supplied_dates: item.suppliedDates ?? [],
});

/** FWD-COVER-1: the dates the entry's events block carries and the dates its omitted_events states it leaves out, each with a reason. */
const eventCoverage = (entry: Obj): { events: string[]; omitted: { date: string; reason: string }[] } => ({
  events: (Array.isArray(entry.events) ? entry.events : []).filter(isObj).map((e) => precisionKey(String(e.event_date ?? ""), typeof e.date_precision === "string" ? e.date_precision : null)),
  omitted: (Array.isArray(entry.omitted_events) ? entry.omitted_events : []).filter(isObj).map((o) => ({ date: String(o.event_date ?? ""), reason: String(o.reason ?? "") })),
});

/** Validate ONE entry: every message names the item and the offending field or claim index. */
export function validateRecordBriefEntry(entry: unknown, i: number, live: RecordLive): EntryResult<RecordPlan> {
  if (!isObj(entry)) return { errors: [`entries[${i}]: must be an object`] };
  const itemId = nonEmpty(entry.item_id) ? entry.item_id : `entries[${i}]`;
  const tag = `item ${itemId}`;
  const errors: string[] = [];
  const residue: string[] = [];
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
      const spanFigures = new Set(figuresIn(c.source_span).map(normalizeFigure));
      for (const figure of figuresIn(figureCheckText(String(c.claim_text ?? "")))) {
        if (!spanFigures.has(normalizeFigure(figure))) cat(`claim_text figure ${JSON.stringify(figure)} does not appear in this claim's own source_span (numeric-figure mirror) -- cite the figure as it appears in the source, or drop it from claim_text`);
      }
    });
  }
  const sections: SectionRow[] = spec && body ? spec.extract(body) : [];
  const textByKey = new Map(sections.map((s) => [s.section_key, s.content_md]));

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
  // The brief rules (src/core/brief/data/rules.json): a `refuse` violation refuses the entry; a `residue` violation routes it to residue with the rule id named. Mirror f, mirrors d and e, the internal-marker check and the verbatim-span check are the rules fact-span-in-own-section, accounting-line-present, no-claim-ledger-json and fact-span-in-capture.
  if (spec && body.trim()) {
    const brief = { body, format: formatType, sections: textByKey, exempt: [], claims: claims.map((c) => ({ kind: String(c.claim_kind ?? ""), section: nonEmpty(c.section) ? c.section : "", span: nonEmpty(c.source_span) ? c.source_span : null, text: String(c.claim_text ?? ""), capture: item.poolText })), ...eventCoverage(entry) };
    const found = validateBrief(brief, columns(meta.ok ? meta.value : null, item, formatType));
    for (const v of found.refuse) at(`${v.rule}: ${v.detail}`);
    if (meta.ok) for (const v of found.residue) residue.push(`${tag}: ${v.rule}: ${v.detail}`);
  }
  // MIRROR 8: criterion 5.
  errors.push(...requiredSlotErrors(claims, live.slots.get(item.itemType) ?? [], tag, item.itemType));
  // The reader's typed blocks (UNIFIED-PRB-DESIGN section 1): structural checks first, then the second reader's binary judges; every required check passes or the brief is residue naming the criterion.
  const emission = validateEmission(entry, tag, live.emit.get(entry.item_id) ?? { captures: new Map(), ids: new Map(), objects: new Map(), locate: null });
  errors.push(...emission.errors);
  if (digestKind("item-briefs")?.secondReader) for (const reason of review("item-briefs", entry).reasons) residue.push(`${tag}: second reader: ${reason}`);
  if (!errors.length && residue.length && emission.plan) {
    const r = residueEmission(entry, emission.plan);
    return { errors, residue, residuePlan: { itemId: entry.item_id, bytes: item.bytes, claims, emission: r.emission, skipped: r.skipped } };
  }
  return errors.length || residue.length ? { errors, residue } : { errors, plan: { itemId: entry.item_id, bytes: item.bytes, claims, emission: emission.plan } };
}
