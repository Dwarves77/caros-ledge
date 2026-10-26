// Ported from old_repo/src/lib/connections/term-recurrence.mjs (lines 1-354)
// Ported from old_repo/src/lib/connections/term-needs.mjs (lines 1-149)
// Vocabulary growth by rule: terms no code vocabulary holds are counted across five detectors (entity-link flags, theme candidates, scenario tags,
// compliance-object candidates, the brief's own mentioned terms); a term is ADOPTED when it recurs in at least `minItems` items (the trust threshold,
// passed in) from at least two sources. Then each adopted term with no authoritative holding becomes a term-need flag, and a non-CELEX absent lineage
// parent becomes a need too. A malformed rationale or flag payload is counted and reported, never swallowed (B-0243).
import { VALIDATORS } from "@/core/entities/crosswalk";
import { buildSubjectRef, createdBy, TERM_NEED_ACTION, TERM_NEED_NAMESPACE, type Finding } from "@/core/flywheel/flags";
import { authorityFloorFor } from "@/core/grounding";

import { normaliseTermKey } from "./adopted";

const MENTIONED_TERM_KINDS = ["material", "term", "standard"] as const;
export const DETECTORS = ["entity-link", "theme-candidate", "scenario-tag", "compliance-object", "brief-terms"] as const;
export type Detector = (typeof DETECTORS)[number];
const MENTIONED_TERMS_MAX = 25;
const MENTIONED_TERM_TEXT_MAX = 120;
const ADOPTION_MIN_SOURCES = 2;
export const ENTITY_LINK_CREATED_BY = "intake-entity-link";
const ENTITY_LINK_ACTION = "review_entity_mention";
const EVIDENCE_SAMPLE_ITEMS = 5;
const EVIDENCE_SAMPLE_SURFACE = 3;

/** The brief's mentioned_terms field: kind and text per entry, deduped, bounded. Errors name the entry. */
function validateMentionedTerms(value: unknown): { terms: { kind: string; text: string }[]; errors: string[] } {
  const errors: string[] = [];
  if (value === null || value === undefined) return { terms: [], errors };
  if (!Array.isArray(value)) return { terms: [], errors: ["mentioned_terms must be a JSON array of { kind, text }"] };
  if (value.length > MENTIONED_TERMS_MAX) errors.push(`mentioned_terms exceeds ${MENTIONED_TERMS_MAX} entries (got ${value.length})`);
  const seen = new Set<string>();
  const terms: { kind: string; text: string }[] = [];
  value.slice(0, MENTIONED_TERMS_MAX).forEach((t: unknown, i: number) => {
    const o = t as { kind?: unknown; text?: unknown } | null;
    if (o === null || typeof o !== "object" || Array.isArray(o)) return void errors.push(`mentioned_terms[${i}] must be an object { kind, text }`);
    if (!(MENTIONED_TERM_KINDS as readonly unknown[]).includes(o.kind)) return void errors.push(`mentioned_terms[${i}].kind must be one of ${MENTIONED_TERM_KINDS.join(", ")} (got ${JSON.stringify(o.kind)})`);
    if (typeof o.text !== "string" || o.text.trim() === "") return void errors.push(`mentioned_terms[${i}].text must be a non-empty string`);
    const text = o.text.trim();
    if (text.length > MENTIONED_TERM_TEXT_MAX) return void errors.push(`mentioned_terms[${i}].text exceeds ${MENTIONED_TERM_TEXT_MAX} characters`);
    const key = normaliseTermKey(text);
    if (!key) return void errors.push(`mentioned_terms[${i}].text has no usable characters`);
    const dedupe = `${o.kind}|${key}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    terms.push({ kind: o.kind as string, text });
  });
  return { terms, errors };
}

export const adoptionRuleText = (minItems: number): string => `distinct_items>=${minItems} AND distinct_sources>=${ADOPTION_MIN_SOURCES}`;
function decideAdoption(counts: { distinct_items: number; distinct_sources: number }, opts: { minItems: number }): { adopt: boolean; rule: string } {
  if (!Number.isInteger(opts.minItems) || opts.minItems < 1) throw new Error("decideAdoption: minItems must be a positive integer");
  return { adopt: counts.distinct_items >= opts.minItems && counts.distinct_sources >= ADOPTION_MIN_SOURCES, rule: adoptionRuleText(opts.minItems) };
}

export interface TermMention {
  kind: string;
  term_key: string;
  label: string;
  item_id: string;
  source_id: string | null;
  detector: Detector;
  surface_text: string;
}
function mention(kind: string, text: unknown, itemId: string, sourceId: string | null | undefined, detector: Detector, surface?: unknown): TermMention | null {
  const key = normaliseTermKey(text);
  return key ? { kind, term_key: key, label: String(text).trim(), item_id: itemId, source_id: sourceId ?? null, detector, surface_text: String(surface ?? text).trim() } : null;
}
const push = <T>(out: T[], x: T | null): void => void (x && out.push(x));

const ENTITY_RATIONALE_RE = /^(identifier|named|shaped):(.+?) resolved to (\d+) item\(s\)$/s;
function actionsOf(flag: { recommended_actions?: unknown }): { actions: { action?: string; rationale?: string }[]; malformed: boolean } {
  let a = flag?.recommended_actions;
  let malformed = false;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = [];
      malformed = true;
    }
  }
  return { actions: Array.isArray(a) ? a : [], malformed };
}

export function mentionsFromEntityLinkFlags(flags: readonly { subject_ref?: string; created_by?: string; recommended_actions?: unknown }[] | null | undefined, sourceByItemId: ReadonlyMap<string, string | null>): { mentions: TermMention[]; malformed: number } {
  const mentions: TermMention[] = [];
  let malformed = 0;
  for (const f of flags ?? []) {
    if (f?.created_by !== ENTITY_LINK_CREATED_BY || !f.subject_ref || !sourceByItemId.has(f.subject_ref)) continue;
    const { actions, malformed: bad } = actionsOf(f);
    if (bad) malformed += 1;
    for (const a of actions) {
      if (a?.action !== ENTITY_LINK_ACTION) continue;
      const m = ENTITY_RATIONALE_RE.exec(String(a.rationale ?? ""));
      if (!m) {
        malformed += 1;
        continue;
      }
      push(mentions, mention("standard", m[2], f.subject_ref, sourceByItemId.get(f.subject_ref), "entity-link", `${m[1]}:${(m[2] as string).trim()}`));
    }
  }
  return { mentions, malformed };
}
export function mentionsFromThemeCandidates(items: readonly { id: string; source_id?: string | null; theme_candidate?: unknown }[] | null | undefined): TermMention[] {
  const out: TermMention[] = [];
  for (const it of items ?? []) {
    const v = it?.theme_candidate;
    if (typeof v !== "string" || normaliseTermKey(v) === "" || normaliseTermKey(v) === "unclassified") continue;
    push(out, mention("theme", v, it.id, it.source_id, "theme-candidate", v));
  }
  return out;
}
export function mentionsFromScenarioTags(items: readonly { id: string; source_id?: string | null; operational_scenario_tags?: unknown }[] | null | undefined, heldScenarioTags: Iterable<string>): TermMention[] {
  const held = new Set([...heldScenarioTags].map(normaliseTermKey));
  const out: TermMention[] = [];
  for (const it of items ?? []) {
    for (const tag of Array.isArray(it?.operational_scenario_tags) ? (it.operational_scenario_tags as unknown[]) : []) {
      if (typeof tag !== "string" || held.has(normaliseTermKey(tag))) continue;
      push(out, mention("scenario", tag, it.id, it.source_id, "scenario-tag", tag));
    }
  }
  return out;
}
export function mentionsFromComplianceCandidates(items: readonly { id: string; source_id?: string | null; compliance_object_candidates?: unknown }[] | null | undefined): TermMention[] {
  const out: TermMention[] = [];
  for (const it of items ?? []) for (const c of Array.isArray(it?.compliance_object_candidates) ? (it.compliance_object_candidates as unknown[]) : []) if (typeof c === "string") push(out, mention("compliance_object", c, it.id, it.source_id, "compliance-object", c));
  return out;
}
function mentionsFromBriefTerms(args: { itemId: string; sourceId?: string | null; terms: unknown }): TermMention[] {
  const out: TermMention[] = [];
  for (const t of validateMentionedTerms(args.terms).terms) push(out, mention(t.kind, t.text, args.itemId, args.sourceId ?? null, "brief-terms", t.text));
  return out;
}

const groupKey = (m: Pick<TermMention, "kind" | "term_key">): string => `${m.kind}|${m.term_key}`;
const mentionKey = (m: TermMention): string => `${m.kind}|${m.term_key}|${m.item_id}|${m.detector}`;
const zeroByDetector = (): Record<Detector, number> => Object.fromEntries(DETECTORS.map((d) => [d, 0])) as Record<Detector, number>;

export interface TermRow {
  id?: string;
  kind: string;
  term_key: string;
  label: string;
  status: "proposed" | "adopted" | "retired";
  distinct_items: number;
  distinct_sources: number;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  adopted_at?: string | null;
  adoption_rule?: string | null;
  evidence?: unknown;
}
/** The kind a reader proposed for a term (evidence.proposed_kind, DIGEST-1 PR B) survives every recount of the term. */
const proposedKind = (t: TermRow | null | undefined): { proposed_kind?: string } => { const k = (t?.evidence as { proposed_kind?: unknown } | null | undefined)?.proposed_kind; return typeof k === "string" ? { proposed_kind: k } : {}; };
export interface TermPlan {
  terms: { key: string; kind: string; term_key: string; existing: TermRow | null; next: TermRow; action: "insert" | "update" | "unchanged"; newly_adopted: boolean }[];
  newMentions: Omit<TermMention, "label">[];
  counts: Record<string, number | Record<string, number>>;
}

/**
 * The plan of one pass: persisted mentions plus this pass's derived ones, grouped per term; a term is adopted by rule (or stays adopted); a retired term is never touched.
 * `now` is an ISO string and is the only clock.
 */
export function buildTermPlan(args: { derived: readonly TermMention[]; persisted: readonly TermMention[]; existingTerms: readonly TermRow[]; now: string; minItems: number }): TermPlan {
  const rule = adoptionRuleText(args.minItems);
  const existingBy = new Map(args.existingTerms.map((t) => [`${t.kind}|${t.term_key}`, t]));
  const merged = new Map<string, TermMention & { isNew: boolean }>();
  for (const m of args.persisted) merged.set(mentionKey(m), { ...m, isNew: false });
  for (const m of args.derived) if (!merged.has(mentionKey(m))) merged.set(mentionKey(m), { ...m, isNew: true });
  const groups = new Map<string, (TermMention & { isNew: boolean })[]>();
  for (const m of merged.values()) groups.set(groupKey(m), [...(groups.get(groupKey(m)) ?? []), m]);
  const detected = zeroByDetector();
  for (const m of merged.values()) detected[m.detector] += 1;
  const terms: TermPlan["terms"] = [];
  const newMentions: TermPlan["newMentions"] = [];
  const c = { terms_total: 0, proposed: 0, adopted: 0, newly_adopted: 0, inserted: 0, updated: 0, unchanged: 0, skipped_retired: 0 };
  for (const [k, ms] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const existing = existingBy.get(k) ?? null;
    const { kind, term_key } = ms[0] as TermMention;
    if (existing?.status === "retired") {
      c.skipped_retired += 1;
      continue;
    }
    const items = new Set(ms.map((m) => m.item_id));
    const sources = new Set(ms.map((m) => m.source_id).filter(Boolean));
    const wasAdopted = existing?.status === "adopted";
    const adopted = wasAdopted || decideAdoption({ distinct_items: items.size, distinct_sources: sources.size }, { minItems: args.minItems }).adopt;
    const fresh = ms.filter((m) => m.isNew);
    const byDetector = zeroByDetector();
    for (const m of ms) byDetector[m.detector] += 1;
    const next: TermRow = {
      kind, term_key, label: existing?.label ?? [...ms].map((m) => m.label).sort()[0] ?? term_key, status: adopted ? "adopted" : "proposed", distinct_items: items.size, distinct_sources: sources.size,
      first_seen_at: existing?.first_seen_at ?? args.now, last_seen_at: fresh.length > 0 ? args.now : (existing?.last_seen_at ?? args.now), adopted_at: adopted ? (existing?.adopted_at ?? args.now) : null,
      adoption_rule: adopted ? (existing?.adoption_rule ?? rule) : null,
      evidence: { detectors: byDetector, sample_items: [...items].sort().slice(0, EVIDENCE_SAMPLE_ITEMS), sample_surface: [...new Set(ms.map((m) => m.surface_text))].sort().slice(0, EVIDENCE_SAMPLE_SURFACE), ...proposedKind(existing) },
    };
    let action: "insert" | "update" | "unchanged" = "insert";
    if (existing) {
      const same = existing.status === next.status && existing.distinct_items === next.distinct_items && existing.distinct_sources === next.distinct_sources && existing.adopted_at === next.adopted_at && existing.adoption_rule === next.adoption_rule && existing.last_seen_at === next.last_seen_at && JSON.stringify(existing.evidence ?? {}) === JSON.stringify(next.evidence);
      action = same ? "unchanged" : "update";
    }
    const newlyAdopted = next.status === "adopted" && !wasAdopted;
    terms.push({ key: k, kind, term_key, existing, next, action, newly_adopted: newlyAdopted });
    c.terms_total += 1;
    c[next.status === "adopted" ? "adopted" : "proposed"] += 1;
    if (newlyAdopted) c.newly_adopted += 1;
    c[action === "insert" ? "inserted" : action === "update" ? "updated" : "unchanged"] += 1;
    for (const m of fresh) newMentions.push({ kind, term_key, item_id: m.item_id, source_id: m.source_id, detector: m.detector, surface_text: m.surface_text });
  }
  return { terms, newMentions, counts: { ...c, new_mentions: newMentions.length, detected_by_detector: detected } };
}

export interface TermWriters {
  insertTerms(rows: Omit<TermRow, "id">[]): Promise<{ rows: { id: string; kind: string; term_key: string }[] }>;
  updateTerm(id: string, patch: Partial<TermRow>): Promise<unknown>;
  insertMentions(rows: { term_id: string; item_id: string; source_id: string | null; detector: string; surface_text: string }[]): Promise<unknown>;
}
/** Apply a plan through writers. A mention whose term has no id (the insert returned no row) throws: nothing is half-applied silently. */
export async function applyTermPlan(plan: TermPlan, w: TermWriters): Promise<{ terms_inserted: number; terms_updated: number; mentions_inserted: number }> {
  const idByKey = new Map<string, string>();
  for (const t of plan.terms) if (t.existing?.id) idByKey.set(t.key, t.existing.id);
  const toInsert = plan.terms.filter((t) => t.action === "insert");
  if (toInsert.length) for (const r of (await w.insertTerms(toInsert.map((t) => ({ ...t.next })))).rows ?? []) idByKey.set(`${r.kind}|${r.term_key}`, r.id);
  let updated = 0;
  for (const t of plan.terms.filter((x) => x.action === "update")) {
    const patch: Record<string, unknown> = { ...t.next };
    for (const k of ["kind", "term_key", "label"]) delete patch[k];
    await w.updateTerm(t.existing?.id as string, patch);
    updated += 1;
  }
  const rows = plan.newMentions.map((m) => {
    const termId = idByKey.get(`${m.kind}|${m.term_key}`);
    if (!termId) throw new Error(`applyTermPlan: no term id for ${m.kind}|${m.term_key} (insert returned no row)`);
    return { term_id: termId, item_id: m.item_id, source_id: m.source_id, detector: m.detector, surface_text: m.surface_text };
  });
  if (rows.length) await w.insertMentions(rows);
  return { terms_inserted: toInsert.length, terms_updated: updated, mentions_inserted: rows.length };
}

/** The brief's own mentioned terms, recorded at write time (a retired term is skipped; a term is proposed on its first mention). */
export async function recordBriefTerms(args: { itemId: string; sourceId?: string | null; terms: unknown; now: string }, w: { readTerms(keys: string[]): Promise<(TermRow & { id: string })[]>; insertTerms: TermWriters["insertTerms"]; upsertMentions(rows: { term_id: string; item_id: string; source_id: string | null; detector: string; surface_text: string }[]): Promise<unknown> }): Promise<{ mentioned: number; terms_inserted: number; mentions_written: number; skipped_retired: number }> {
  const ms = mentionsFromBriefTerms(args);
  if (!ms.length) return { mentioned: 0, terms_inserted: 0, mentions_written: 0, skipped_retired: 0 };
  const existing = await w.readTerms([...new Set(ms.map((m) => m.term_key))]);
  const existingBy = new Map(existing.map((t) => [`${t.kind}|${t.term_key}`, t]));
  const idByKey = new Map<string, string>();
  let skippedRetired = 0;
  const toInsert: Omit<TermRow, "id">[] = [];
  const queued = new Set<string>();
  for (const m of ms) {
    const k = groupKey(m);
    const e = existingBy.get(k);
    if (e?.status === "retired") {
      skippedRetired += 1;
      continue;
    }
    if (e) idByKey.set(k, e.id);
    else if (!queued.has(k)) {
      queued.add(k);
      toInsert.push({ kind: m.kind, term_key: m.term_key, label: m.label, status: "proposed", distinct_items: 1, distinct_sources: args.sourceId ? 1 : 0, first_seen_at: args.now, last_seen_at: args.now, adopted_at: null, adoption_rule: null, evidence: { detectors: { ...zeroByDetector(), "brief-terms": 1 }, sample_items: [args.itemId], sample_surface: [m.surface_text] } });
    }
  }
  if (toInsert.length) for (const r of (await w.insertTerms(toInsert)).rows ?? []) idByKey.set(`${r.kind}|${r.term_key}`, r.id);
  const rows = ms.filter((m) => idByKey.has(groupKey(m))).map((m) => ({ term_id: idByKey.get(groupKey(m)) as string, item_id: args.itemId, source_id: args.sourceId ?? null, detector: "brief-terms", surface_text: m.surface_text }));
  if (rows.length) await w.upsertMentions(rows);
  return { mentioned: ms.length, terms_inserted: toInsert.length, mentions_written: rows.length, skipped_retired: skippedRetired };
}

// -- term needs ---------------------------------------------------------------------------------------------------------------------------------------

const TERM_NEED_RULE = "adopted term with no held item whose primary source base tier is at or above the item type authority floor";
const LINEAGE_NEED_RULE = "absent lineage parent whose identifier is not a CELEX id";
const DESCRIPTION_MAX = 480;
const SAMPLE_CITING_ITEMS = 5;
const KIND_PHRASE: Record<string, string> = { standard: "standard", material: "material", theme: "topic", scenario: "operational scenario", compliance_object: "compliance object", term: "term" };

const needTextFor = (kind: string, label: unknown): string => `${String(label ?? "").replace(/\s+/g, " ").trim()} ${KIND_PHRASE[kind] ?? "term"} authoritative source`;

export interface NeedItem {
  id?: string;
  is_archived?: boolean | null;
  provenance_status?: string | null;
  origin_class?: string | null;
  source_id?: string | null;
  item_type?: string | null;
}
export interface NeedSource {
  base_tier?: number | null;
  tier_override?: number | null;
}
/** An item qualifies as a holding when it is live, verified, not community, and its primary source's tier is at or above the type's authority floor. */
function holdingQualifies(item: NeedItem | null | undefined, source: NeedSource | null | undefined): boolean {
  if (!item || !source || item.is_archived || item.provenance_status !== "verified") return false;
  if (item.origin_class === "community" || item.origin_class === "community-corroborated" || !item.source_id) return false;
  const tier = source.tier_override ?? source.base_tier ?? null;
  if (!Number.isInteger(tier)) return false;
  const floor = authorityFloorFor(item.item_type);
  return floor == null ? true : (tier as number) <= floor;
}

function termNeedRow(args: { term: { id?: string | null; kind: string; term_key?: string | null }; need: string; counts?: { distinct_items?: number | null; distinct_sources?: number | null } | null; subjectRef?: string | null; rule?: string; extra?: Record<string, unknown> }): Finding["row"] {
  const rule = args.rule ?? TERM_NEED_RULE;
  return {
    category: "coverage_gap", subject_type: "system", subject_ref: args.subjectRef ?? String(args.term.id), status: "open", created_by: createdBy(TERM_NEED_NAMESPACE, args.term.kind),
    description: `Term need: ${args.need}`.slice(0, DESCRIPTION_MAX),
    recommended_actions: [{ action: TERM_NEED_ACTION, need: args.need, kind: args.term.kind, term_key: args.term.term_key ?? null, term_id: args.term.id ?? null, distinct_items: args.counts?.distinct_items ?? null, distinct_sources: args.counts?.distinct_sources ?? null, rule, rationale: `${rule}; a source stating the need in words is wanted`, ...(args.extra ?? {}) }],
  };
}

/** One term-need finding per adopted term with no qualifying holding among the items that mention it. */
export function planTermNeeds(args: { terms: readonly (TermRow & { id: string })[]; mentions: readonly { term_id: string; item_id: string }[]; items: ReadonlyMap<string, NeedItem>; sources: ReadonlyMap<string, NeedSource> }): { fresh: Finding[]; counts: { adopted_terms: number; satisfied: number; needs: number } } {
  const itemsByTerm = new Map<string, Set<string>>();
  for (const m of args.mentions) itemsByTerm.set(m.term_id, (itemsByTerm.get(m.term_id) ?? new Set()).add(m.item_id));
  const adopted = args.terms.filter((t) => t.status === "adopted").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fresh: Finding[] = [];
  let satisfied = 0;
  for (const t of adopted) {
    const held = [...(itemsByTerm.get(t.id) ?? [])].some((id) => {
      const it = args.items.get(id);
      return holdingQualifies(it, it?.source_id ? (args.sources.get(it.source_id) ?? null) : null);
    });
    if (held) satisfied += 1;
    else fresh.push({ subjectRef: t.id, row: termNeedRow({ term: t, need: needTextFor(t.kind, t.label), counts: t }) });
  }
  return { fresh, counts: { adopted_terms: adopted.length, satisfied, needs: fresh.length } };
}

export function celexOf(identifier: unknown): string | null {
  const bare = String(identifier ?? "").trim().replace(/^CELEX[:\s]*/i, "").toUpperCase();
  return bare && VALIDATORS.CELEX(bare) ? bare : null;
}

/** Absent lineage parents: CELEX ids become explicit register targets, any other identifier becomes a term-need finding. */
export function planLineageNeeds(targets: readonly { identifier?: string; relationship?: string; citing_item_id?: string }[]): { celex: string[]; fresh: Finding[]; counts: { distinct_identifiers: number; celex_targets: number; non_celex_needs: number } } {
  const byId = new Map<string, { identifier: string; celex: string | null; relationships: Set<string>; citing: Set<string> }>();
  for (const t of targets) {
    const identifier = String(t?.identifier ?? "").trim();
    if (!identifier) continue;
    const key = celexOf(identifier) ?? identifier.toLowerCase();
    const e = byId.get(key) ?? { identifier, celex: celexOf(identifier), relationships: new Set<string>(), citing: new Set<string>() };
    byId.set(key, e);
    if (t.relationship) e.relationships.add(t.relationship);
    if (t.citing_item_id) e.citing.add(t.citing_item_id);
  }
  const celex: string[] = [];
  const fresh: Finding[] = [];
  for (const [key, e] of [...byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (e.celex) {
      celex.push(e.celex);
      continue;
    }
    const subjectRef = buildSubjectRef("lineage", key);
    fresh.push({ subjectRef, row: termNeedRow({ term: { id: null, kind: "standard", term_key: key }, need: needTextFor("standard", e.identifier), counts: null, subjectRef, rule: LINEAGE_NEED_RULE, extra: { identifier: e.identifier, relationships: [...e.relationships].sort(), citing_item_ids: [...e.citing].sort().slice(0, SAMPLE_CITING_ITEMS) } }) });
  }
  return { celex, fresh, counts: { distinct_identifiers: byId.size, celex_targets: celex.length, non_celex_needs: fresh.length } };
}
