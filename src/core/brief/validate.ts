// Ported from old_repo/src/lib/agent/parse-output.ts (lines 380-1003)
// Ported from old_repo/src/lib/agent/metadata-vocab.ts (lines 76-107)
// Ported from old_repo/src/lib/agent/metadata-vocab.ts (lines 151-159)
// The object validators: the metadata object against the contract table, claim records, and the content-first cross-link of a
// FACT to the capture that contains its span. The input is an OBJECT (no YAML, no fences, no sentinel): the tolerance for
// model drift (parse-output.ts 254-378, 921-959) is not ported because nothing emits free text any more.
import { isVerbatim } from "@/core/contracts/verbatim";

import {
  BRIEF_EXTRA_FIELDS, BRIEF_FIELDS, CAPS, CLAIM_KINDS, COMPLIANCE_OBJECTS, CONTRACT_VERSION, FORMAT_TYPES, MENTIONED_TERMS_CONTRACT,
  PRIORITIES, SEVERITIES, SIGNAL_BANDS, THEMES, TOPIC_TAGS, URGENCY_TIERS, type AdoptedTerms, type BriefField,
} from "./contract";
import { adoptedThemeTokens, bankCandidate, SEVERITY_TO_PRIORITY } from "./vocab";

export interface TrajectoryPoints { points: { date: string; value: number }[]; base_date: string; base_label: string }
export interface RequirementTrajectory { steps: { date: string; value: string; label?: string }[]; note?: string }
export interface MentionedTerm { kind: string; text: string }

export interface BriefMetadata {
  severity: string; priority: string; urgency_tier: string; format_type: string;
  topic_tags: string[]; signal_band: string | null; theme: string | null; trajectory_points: TrajectoryPoints | null;
  what_is_it: string | null; what_it_changes: string | null; does_not_resolve: string | null; conversion_trigger: string | null; cross_references: string | null;
  cost_mechanism: string | null; penalty_range: string | null; enforcement_body: string | null; requirement_trajectory: RequirementTrajectory | null;
  why_matters: string | null; key_data: string[];
  operational_scenario_tags: string[]; compliance_object_tags: string[]; compliance_object_candidates: string[]; mentioned_terms: MentionedTerm[];
  related_items: string[]; intersection_summary: string | null; sources_used: string[];
  last_regenerated_at: string; regeneration_skill_version: string;
}
export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCENARIO_TAG = /^[0-9a-z][0-9a-z-]*[0-9a-z]$/i;
export const isUuidShape = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

class FieldError extends Error {}
const bad = (msg: string): never => {
  throw new FieldError(msg);
};
const isAbsent = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && (v.trim() === "" || v.trim().toLowerCase() === "null"));
const asArray = (v: unknown, name: string): unknown[] => (Array.isArray(v) ? v : bad(`${name} must be an array`));
const strings = (v: unknown, name: string): string[] =>
  asArray(v, name).map((x) => (typeof x === "string" && x.trim() ? x.trim() : bad(`${name} entries must be non-empty strings`)));

interface Ctx { raw: Record<string, unknown>; adopted: AdoptedTerms | undefined; warnings: string[]; now: Date }
type KindCheck = (v: unknown, f: BriefField, ctx: Ctx) => unknown;

const oneOf = (name: string, v: unknown, allowed: readonly string[]): string => (typeof v === "string" && allowed.includes(v) ? v : bad(`Invalid ${name}: "${String(v)}". Allowed: ${allowed.join(", ")}`));
const format = (ctx: Ctx): string | null => (typeof ctx.raw.format_type === "string" ? ctx.raw.format_type : null);

const KINDS: Record<string, KindCheck> = {
  text: (v) => (isAbsent(v) ? null : typeof v === "string" ? v.trim() : bad("must be a string or null")),
  severity: (v) => oneOf("severity", v, SEVERITIES.map((s) => s.label)),
  priority: (v, _f, ctx) => {
    const p = oneOf("priority", v, PRIORITIES);
    const want = SEVERITY_TO_PRIORITY[String(ctx.raw.severity)];
    return want && want !== p ? bad(`Priority "${p}" does not match the locked mapping for severity "${String(ctx.raw.severity)}" (expected "${want}")`) : p;
  },
  urgency: (v) => oneOf("urgency_tier", v, URGENCY_TIERS),
  format: (v) => oneOf("format_type", v, FORMAT_TYPES),
  topic_tags: (v) => {
    const tags = strings(v, "topic_tags");
    if (tags.length > CAPS.topicTags) bad(`topic_tags exceeds ${CAPS.topicTags} values: ${tags.join(", ")}`);
    for (const t of tags) if (!TOPIC_TAGS.includes(t)) bad(`topic_tags contains an out-of-vocabulary value: "${t}". Allowed: ${TOPIC_TAGS.join(", ")}`);
    return tags;
  },
  signal_band: (v, f, ctx) => {
    if (isAbsent(v)) return null;
    const band = String(v).trim().toLowerCase();
    if (!SIGNAL_BANDS.includes(band)) bad(`Invalid signal_band: "${band}". Allowed: ${SIGNAL_BANDS.join(", ")} or null`);
    return format(ctx) === f.onlyFormat ? band : bad(`signal_band may only be non-null when format_type is ${f.onlyFormat} (got "${String(format(ctx))}")`);
  },
  theme: (v, f, ctx) => {
    if (isAbsent(v)) return null;
    const theme = String(v).trim().toLowerCase();
    const allowed = [...THEMES, ...adoptedThemeTokens(ctx.adopted)];
    if (!allowed.includes(theme)) bad(`Invalid theme: "${theme}". Allowed: ${allowed.join(", ")} or null`);
    return format(ctx) === f.onlyFormat ? theme : bad(`theme may only be non-null when format_type is ${f.onlyFormat} (got "${String(format(ctx))}")`);
  },
  scenario_tags: (v) => {
    const tags = strings(v, "operational_scenario_tags");
    if (tags.length > CAPS.scenarioTags) bad(`operational_scenario_tags exceeds ${CAPS.scenarioTags} values: ${tags.join(", ")}`);
    for (const t of tags) if (!SCENARIO_TAG.test(t)) bad(`operational_scenario_tags contains a malformed value: "${t}". Expected lower-case kebab-case (e.g. ocean-bunkering).`);
    return tags;
  },
  compliance_tags: (v, _f, ctx) => {
    const raw = strings(v, "compliance_object_tags");
    const banked = raw.map((t) => ({ t, ...bankCandidate("compliance_object", t, ctx.adopted, COMPLIANCE_OBJECTS) }));
    const held = banked.map((b) => b.held).filter((h): h is string => h !== null);
    if (held.length > CAPS.complianceTags) ctx.warnings.push(`compliance_object_tags: ${held.length - CAPS.complianceTags} in-vocabulary value(s) past the cap of ${CAPS.complianceTags} dropped`);
    ctx.raw.compliance_object_candidates = [...new Set(banked.map((b) => b.candidate).filter((c): c is string => c !== null))].slice(0, CAPS.complianceCandidates);
    return held.slice(0, CAPS.complianceTags);
  },
  uuid_array: (v, f) => {
    const ids = strings(v, f.name);
    for (const id of ids) if (!UUID.test(id)) bad(`${f.name} contains a non-UUID value: ${id}`);
    return ids;
  },
  iso_date: (v, _f, ctx) => (isAbsent(v) ? ctx.now.toISOString() : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? ctx.now.toISOString() : bad(`Invalid last_regenerated_at: "${String(v)}"`)),
  version: (v) => (v === CONTRACT_VERSION ? v : bad(`contract version mismatch: got "${String(v)}", the current contract is "${CONTRACT_VERSION}"`)),
  string_array: (v) => (isAbsent(v) ? [] : strings(v, "array")),
  trajectory: (v) => {
    if (isAbsent(v)) return null;
    const o = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
    if (!o || typeof o !== "object" || Array.isArray(o)) bad("requirement_trajectory must be a JSON object");
    const t = o as { steps?: unknown; note?: unknown };
    const steps = asArray(t.steps, "requirement_trajectory.steps").map((s) => {
      const x = s as Record<string, unknown> | null;
      if (!x || typeof x.date !== "string" || typeof x.value !== "string" || (x.label !== undefined && typeof x.label !== "string")) bad("requirement_trajectory.steps entries must be { date: string, value: string, label?: string }");
      return { date: x!.date as string, value: x!.value as string, ...(x!.label !== undefined ? { label: x!.label as string } : {}) };
    });
    if (t.note !== undefined && typeof t.note !== "string") bad("requirement_trajectory.note must be a string when present");
    return { steps, ...(typeof t.note === "string" ? { note: t.note } : {}) };
  },
  price_points: (v, f, ctx) => {
    if (isAbsent(v)) return null;
    if (ctx.raw.signal_band !== "price") bad(`trajectory_points may only be non-null when signal_band === 'price' (got ${String(ctx.raw.signal_band ?? "null")})`);
    const o = v as { points?: unknown; base_date?: unknown; base_label?: unknown };
    if (!o || typeof o !== "object" || typeof o.base_date !== "string" || typeof o.base_label !== "string") bad(`${f.name} needs { points, base_date: string, base_label: string }`);
    const points = asArray(o.points, "trajectory_points.points").map((p) => {
      const x = p as { date?: unknown; value?: unknown } | null;
      return x && typeof x.date === "string" && typeof x.value === "number" ? { date: x.date, value: x.value } : bad("trajectory_points.points entries must be { date: string, value: number }");
    });
    return { points, base_date: o.base_date as string, base_label: o.base_label as string };
  },
  mentioned_terms: (v) => {
    if (isAbsent(v)) return [];
    const list = asArray(v, "mentioned_terms");
    const { kinds, max, textMax } = MENTIONED_TERMS_CONTRACT;
    if (list.length > max) bad(`mentioned_terms exceeds ${max} entries (got ${list.length})`);
    const seen = new Set<string>();
    const out: MentionedTerm[] = [];
    list.forEach((t, i) => {
      const o = t as { kind?: unknown; text?: unknown } | null;
      if (!o || typeof o !== "object" || typeof o.kind !== "string" || !kinds.includes(o.kind)) bad(`mentioned_terms[${i}].kind must be one of ${kinds.join(", ")}`);
      const text = typeof o!.text === "string" ? o!.text.trim() : "";
      if (!text) bad(`mentioned_terms[${i}].text must be a non-empty string`);
      if (text.length > textMax) bad(`mentioned_terms[${i}].text exceeds ${textMax} characters`);
      const key = `${o!.kind as string}|${text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: o!.kind as string, text });
      }
    });
    return out;
  },
};

/**
 * validateMetadata(obj): every field of the contract table against its kind, ALL errors collected (an author fixes them in one
 * round). Out-of-vocabulary compliance objects are banked as candidates, never dropped silently; an over-long intersection
 * summary is truncated with a warning; last_regenerated_at is stamped from `now`, never trusted from the author.
 */
export function validateMetadata(input: unknown, opts: { adopted?: AdoptedTerms; now: Date }): Validated<BriefMetadata> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["metadata must be an object"] };
  const raw = { ...(input as Record<string, unknown>) };
  const ctx: Ctx = { raw, adopted: opts.adopted, warnings: [], now: opts.now };
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of [...BRIEF_FIELDS, ...BRIEF_EXTRA_FIELDS]) {
    if (f.name === "full_brief") continue;
    const present = raw[f.name] !== undefined;
    if (!present && f.required && f.kind !== "iso_date") {
      errors.push(`Missing required field: ${f.name}`);
      continue;
    }
    try {
      let value = KINDS[f.kind]?.(raw[f.name], f, ctx);
      if (f.name === "intersection_summary" && typeof value === "string" && value.length > CAPS.intersectionSummary) {
        ctx.warnings.push(`intersection_summary truncated from ${value.length} to ${CAPS.intersectionSummary} chars`);
        value = `${value.slice(0, CAPS.intersectionSummary - 3)}...`;
      }
      out[f.name] = value;
    } catch (e) {
      if (!(e instanceof FieldError || e instanceof SyntaxError)) throw e;
      errors.push(`${f.name}: ${e.message}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  out.compliance_object_candidates = ctx.raw.compliance_object_candidates ?? [];
  return { ok: true, value: out as unknown as BriefMetadata, warnings: ctx.warnings };
}

export interface ClaimRecord {
  section: string;
  claim_text: string;
  claim_kind: string;
  source_span: string | null;
  source_id: string | null;
  source_url: string | null;
  slot_key: string | null;
  search_result_id?: string | null;
}

/**
 * validateClaimRecords(array): each record checked; a FACT needs a span and a source id or url, a source_id must be a UUID.
 * Returns the valid records AND a per-record error list, so a strict caller refuses and a lenient one skips by choice.
 */
export function validateClaimRecords(input: unknown): { claims: ClaimRecord[]; errors: string[] } {
  if (!Array.isArray(input)) return { claims: [], errors: ["claim ledger must be a JSON array"] };
  const claims: ClaimRecord[] = [];
  const errors: string[] = [];
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void errors.push(`claim ${i} is not an object`);
    const o = raw as Record<string, unknown>;
    const kind = typeof o.claim_kind === "string" ? o.claim_kind : "";
    if (!CLAIM_KINDS.includes(kind)) return void errors.push(`claim ${i} has invalid claim_kind: ${String(o.claim_kind)}`);
    const text = typeof o.claim_text === "string" ? o.claim_text : "";
    if (!text.trim()) return void errors.push(`claim ${i} has empty claim_text`);
    const s = (k: string) => (o[k] == null ? null : String(o[k]));
    const rec: ClaimRecord = { section: o.section == null ? "" : String(o.section), claim_text: text, claim_kind: kind, source_span: s("source_span"), source_id: s("source_id"), source_url: s("source_url"), slot_key: s("slot_key"), search_result_id: null };
    if (kind === "FACT") {
      if (!rec.source_span?.trim()) return void errors.push(`FACT claim ${i} ("${text.slice(0, 50)}") is missing source_span`);
      if (!rec.source_id && !rec.source_url) return void errors.push(`FACT claim ${i} ("${text.slice(0, 50)}") has neither source_id nor source_url`);
    }
    if (rec.source_id !== null && !UUID.test(rec.source_id)) return void errors.push(`claim ${i} has non-UUID source_id: ${rec.source_id}`);
    claims.push(rec);
  });
  return { claims, errors };
}

export interface PoolLink { id: string; result_url: string | null; result_content?: string | null }

/**
 * Attribute each FACT to the row whose CAPTURE contains its span: first among the rows sharing the cited URL, then any row of
 * the pool (the claim's source_url is re-pointed to that row's URL, so the attribution is honest). Only when no capture contains
 * the span does the URL match apply, and criterion 3 then refuses honestly. ONE case rule, the database's (isVerbatim): the old
 * code matched case-sensitively here and case-insensitively in the kept filter, so a span could be kept and then fail to attribute.
 */
export function crossLinkClaimSources(claims: ClaimRecord[], searches: PoolLink[]): ClaimRecord[] {
  const byUrl = new Map<string, PoolLink[]>();
  for (const s of searches) if (s.result_url) byUrl.set(s.result_url, [...(byUrl.get(s.result_url) ?? []), s]);
  const contains = (s: PoolLink, span: string) => !!s.result_content && isVerbatim(s.result_content, span);
  return claims.map((c) => {
    const sameUrl = c.source_url ? (byUrl.get(c.source_url) ?? []) : [];
    const span = c.claim_kind === "FACT" ? c.source_span : null;
    if (span) {
      const hit = sameUrl.find((s) => contains(s, span)) ?? searches.find((s) => contains(s, span));
      if (hit) return { ...c, search_result_id: hit.id, source_url: hit.result_url ?? c.source_url };
    }
    const last = sameUrl[sameUrl.length - 1];
    return last ? { ...c, search_result_id: last.id } : { ...c, search_result_id: c.search_result_id ?? null };
  });
}
export { bankCandidate };
