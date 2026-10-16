// Ported from old_repo/scripts/connections/term-recurrence.mjs (lines 20-186)
// Ported from old_repo/scripts/connections/raise-term-needs.mjs (lines 8-147)
// The term pass, one function: count term mentions across the five detectors, propose and adopt terms by rule (the trust citation-frequency threshold and at
// least two sources), record the mentions, mint the entities of newly adopted standards and materials, then raise one term-need flag per adopted term with
// no authoritative holding and per non-CELEX absent lineage parent, closing each by rule when the need stops reproducing. Writes vocabulary_terms,
// vocabulary_mentions, entities (adopted terms only) and integrity_flags in the term-need namespace.
import type { Db } from "@/core/db";
import { allRows, rowsByIds } from "@/core/db";
import { LINEAGE_GAP_CREATED_BY, planLineageGapTargets, type GapFlag } from "@/core/entities/lineage";
import { readLinkCorpus } from "@/core/entities/link-items";
import { planReflect, TERM_NEED_NAMESPACE } from "@/core/flywheel/flags";
import { SIGNATURE_CAP } from "@/core/flywheel/signature";
import tierMovement from "@/core/sources/data/tier-movement.json";
import type { RunResult } from "@/core/sources/run-result";
import { mintAdoptedTermEntities, readAdoptedVocabulary } from "@/core/vocabulary/adopted";
import { SCENARIO_TAGS } from "@/core/tags/vocabulary";
import {
  adoptionRuleText, applyTermPlan, buildTermPlan, DETECTORS, ENTITY_LINK_CREATED_BY, mentionsFromComplianceCandidates, mentionsFromEntityLinkFlags, mentionsFromScenarioTags, mentionsFromThemeCandidates,
  planLineageNeeds, planTermNeeds, type NeedItem, type NeedSource, type TermMention, type TermRow,
} from "@/core/vocabulary/terms";

export interface TermPassDeps {
  sb: Db;
  now: () => Date;
}
export interface TermPassInput {
  dry: boolean;
  /** The citation-frequency threshold; defaults to the trust module's value (tier-movement data). */
  minItems?: number;
}
export const TRUST_MIN_ITEMS: number = (tierMovement as { q7: { citationFrequencyPromotionThreshold: number } }).q7.citationFrequencyPromotionThreshold;
export const NEED_RESOLVE_NOTE = "term-need closed by rule: the need is no longer reproduced (an authoritative holding exists, the term is no longer adopted, or the lineage parent is now held).";
type Item = { id: string; source_id: string | null; theme_candidate?: string | null; operational_scenario_tags?: string[] | null; compliance_object_candidates?: string[] | null };

export async function termPass(deps: TermPassDeps, input: TermPassInput): Promise<RunResult> {
  const { sb } = deps;
  const apply = !input.dry;
  const nowIso = deps.now().toISOString();
  const minItems = input.minItems ?? TRUST_MIN_ITEMS;
  const notes: string[] = [];
  const counts: Record<string, number> = {};
  let failed = 0;

  const items = await allRows<Item>(sb, "intelligence_items", "id, source_id, theme_candidate, operational_scenario_tags, compliance_object_candidates", { cap: SIGNATURE_CAP, where: (q) => q.eq("provenance_status", "verified").eq("is_archived", false) });
  const sourceByItemId = new Map(items.map((it) => [it.id, it.source_id ?? null]));
  const flags = await allRows<{ id: string; subject_ref: string; created_by: string; recommended_actions: unknown }>(sb, "integrity_flags", "id, subject_ref, created_by, recommended_actions", { cap: SIGNATURE_CAP, where: (q) => q.eq("created_by", ENTITY_LINK_CREATED_BY) });
  const terms = await allRows<TermRow & { id: string }>(sb, "vocabulary_terms", "*", { cap: SIGNATURE_CAP });
  const mentions = await allRows<{ term_id: string; item_id: string; source_id: string | null; detector: string; surface_text: string }>(sb, "vocabulary_mentions", "term_id, item_id, source_id, detector, surface_text", { cap: SIGNATURE_CAP });

  const link = mentionsFromEntityLinkFlags(flags, sourceByItemId);
  if (link.malformed) notes.push(`${link.malformed} entity-link flag payload(s) were malformed and skipped (counted, not swallowed)`);
  const derivedByDetector: Record<string, TermMention[]> = {
    "entity-link": link.mentions,
    "theme-candidate": mentionsFromThemeCandidates(items),
    "scenario-tag": mentionsFromScenarioTags(items, SCENARIO_TAGS),
    "compliance-object": mentionsFromComplianceCandidates(items),
  };
  const termById = new Map(terms.map((t) => [t.id, t]));
  const persisted: TermMention[] = [];
  for (const row of mentions) {
    const t = termById.get(row.term_id);
    if (!t || !sourceByItemId.has(row.item_id)) continue;
    persisted.push({ kind: t.kind, term_key: t.term_key, label: t.label, item_id: row.item_id, source_id: row.source_id ?? sourceByItemId.get(row.item_id) ?? null, detector: row.detector as TermMention["detector"], surface_text: row.surface_text });
  }
  const plan = buildTermPlan({ derived: Object.values(derivedByDetector).flat(), persisted, existingTerms: terms, now: nowIso, minItems });
  const pc = plan.counts as Record<string, number>;
  Object.assign(counts, { eligible_items: items.length, terms_total: pc.terms_total ?? 0, proposed: pc.proposed ?? 0, adopted: pc.adopted ?? 0, newly_adopted: pc.newly_adopted ?? 0, plan_insert: pc.inserted ?? 0, plan_update: pc.updated ?? 0, plan_unchanged: pc.unchanged ?? 0, skipped_retired: pc.skipped_retired ?? 0, new_mentions: pc.new_mentions ?? 0, min_items: minItems });
  notes.push(`adoption rule: ${adoptionRuleText(minItems)} (detectors: ${DETECTORS.join(", ")})`);

  if (apply) {
    const written = await applyTermPlan(plan, {
      insertTerms: async (rows) => {
        const { data, error } = await sb.from("vocabulary_terms").insert(rows).select("id, kind, term_key");
        if (error) throw new Error(`vocabulary_terms insert failed: ${error.message}`);
        return { rows: (data ?? []) as { id: string; kind: string; term_key: string }[] };
      },
      updateTerm: async (id, patch) => {
        const { error } = await sb.from("vocabulary_terms").update(patch).eq("id", id);
        if (error) throw new Error(`vocabulary_terms update failed: ${error.message}`);
      },
      insertMentions: async (rows) => {
        const { error } = await sb.from("vocabulary_mentions").insert(rows);
        if (error) throw new Error(`vocabulary_mentions insert failed: ${error.message}`);
      },
    });
    Object.assign(counts, written);
    const vocab = await readAdoptedVocabulary(sb);
    if (vocab.note) notes.push(vocab.note);
    const minted = await mintAdoptedTermEntities(sb, vocab.adopted);
    counts.entities_minted = minted.minted;
    if (minted.error) {
      failed += 1;
      notes.push(minted.error);
    }
  }

  // Needs: re-read the terms so a term adopted in this very pass is considered (rule 17: the pass finishes what it started).
  const currentTerms = apply ? await allRows<TermRow & { id: string }>(sb, "vocabulary_terms", "id, kind, term_key, label, status, distinct_items, distinct_sources", { cap: SIGNATURE_CAP }) : terms;
  const currentMentions = apply ? await allRows<{ term_id: string; item_id: string }>(sb, "vocabulary_mentions", "term_id, item_id", { cap: SIGNATURE_CAP }) : mentions;
  const adoptedIds = new Set(currentTerms.filter((t) => t.status === "adopted").map((t) => t.id));
  const relevant = currentMentions.filter((m) => adoptedIds.has(m.term_id));
  const itemIds = [...new Set(relevant.map((m) => m.item_id))].sort();
  const needItems = itemIds.length
    ? await rowsByIds<NeedItem & { id: string }>(sb, "intelligence_items", "id, item_type, provenance_status, is_archived, origin_class, source_id", itemIds)
    : [];
  const sourceIds = [...new Set(needItems.map((i) => i.source_id).filter((s): s is string => !!s))].sort();
  const needSources = sourceIds.length
    ? await rowsByIds<NeedSource & { id: string }>(sb, "sources", "id, base_tier, tier_override", sourceIds)
    : [];
  const termPlan = planTermNeeds({ terms: currentTerms, mentions: relevant, items: new Map(needItems.map((i) => [i.id, i])), sources: new Map(needSources.map((s) => [s.id, s])) });
  const lineageFlags = await allRows<GapFlag & { status: string }>(sb, "integrity_flags", "id, subject_ref, created_by, description, recommended_actions, status", { cap: SIGNATURE_CAP, where: (q) => q.eq("created_by", LINEAGE_GAP_CREATED_BY).in("status", ["open", "in_review"]) });
  const lineage = planLineageNeeds(planLineageGapTargets(lineageFlags, await readLinkCorpus(sb)).targets);
  const openNeeds = await allRows<{ id: string; subject_ref: string; created_by: string }>(sb, "integrity_flags", "id, subject_ref, created_by", { cap: SIGNATURE_CAP, where: (q) => q.like("created_by", `${TERM_NEED_NAMESPACE}%`).in("status", ["open", "in_review"]) });
  const reflect = planReflect(openNeeds, [...termPlan.fresh, ...lineage.fresh]);
  Object.assign(counts, { adopted_terms: termPlan.counts.adopted_terms, terms_with_holding: termPlan.counts.satisfied, term_needs: termPlan.counts.needs, lineage_open_flags: lineageFlags.length, lineage_non_celex_needs: lineage.counts.non_celex_needs, lineage_celex_targets: lineage.counts.celex_targets, open_needs_before: openNeeds.length, needs_to_raise: reflect.newRows.length, needs_to_close: reflect.staleIds.length });
  if (apply) {
    for (let i = 0; i < reflect.newRows.length; i += 200) {
      const batch = reflect.newRows.slice(i, i + 200);
      const { error } = await sb.from("integrity_flags").insert(batch);
      if (error) {
        failed += batch.length;
        notes.push(`term-need insert chunk ${i} failed: ${error.message}`);
      } else counts.needs_raised = (counts.needs_raised ?? 0) + batch.length;
    }
    for (let i = 0; i < reflect.staleIds.length; i += 100) {
      const ids = reflect.staleIds.slice(i, i + 100);
      const { error } = await sb.from("integrity_flags").update({ status: "resolved", resolved_at: nowIso, resolved_by: "term-pass", resolution_note: NEED_RESOLVE_NOTE }).in("id", ids).in("status", ["open", "in_review"]);
      if (error) {
        failed += ids.length;
        notes.push(`term-need close chunk ${i} failed: ${error.message}`);
      } else counts.needs_closed = (counts.needs_closed ?? 0) + ids.length;
    }
  }
  return { counts, outcome: failed ? "partial" : "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
}
