// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 29-32)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 66-100)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 108-247)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 298-303)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 401-443)
// Rule-based adoption of derived tags (ADR-025, no human gate): a high-confidence proposal adopts; a medium one adopts only when its tag is in the live
// vocabulary AND its keyword evidence is re-confirmed in the item's own text; everything else is declined with the reason. The patch is merge-only
// (nothing existing is removed), respects the per-field cap, and never re-adds a tag an admin removed. The decision is recorded as a flag born resolved.
import type { Db } from "@/core/db";
import { buildDecisionNote, buildSubjectRef, createdBy, TAG_NAMESPACE, type Decision } from "@/core/flywheel/flags";
import type { AdoptedVocabulary } from "@/core/vocabulary/adopted";
import { filterTagProposals, readItemCorrections, removedTagsFor } from "@/core/corrections";

import { FIELD_CAPS, meetsConfidence, type Confidence, type TagProposal } from "./derive";
import { heldVocabulary, TAG_FIELDS, type TagField } from "./vocabulary";

const AUTO_ADOPT_THRESHOLD: Confidence = "high";
const TAG_EVIDENCE_TEXT_FIELDS = ["title", "what_is_it", "summary", "full_brief"] as const;
const DECISION_SUBTYPE = "decided";

export interface TaggedItem {
  id: string;
  title?: string | null;
  what_is_it?: string | null;
  summary?: string | null;
  full_brief?: string | null;
  canonical_instrument_key?: string | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
  topic_tags?: string[] | null;
}
export type DecidedProposal = TagProposal & Decision;

function itemOwnText(item: Partial<TaggedItem>): string {
  return TAG_EVIDENCE_TEXT_FIELDS.map((f) => (typeof item?.[f] === "string" ? (item[f] as string) : "")).join("\n");
}
const evidencePresentInItemText = (evidence: unknown, item: Partial<TaggedItem>): boolean => {
  const needle = String(evidence ?? "").trim().toLowerCase();
  return needle !== "" && itemOwnText(item).toLowerCase().includes(needle);
};

function decideTagProposal(proposal: TagProposal, item: Partial<TaggedItem>, opts: { threshold?: Confidence; adopted?: Partial<AdoptedVocabulary> } = {}): DecidedProposal {
  const threshold = opts.threshold ?? AUTO_ADOPT_THRESHOLD;
  const label = `${proposal.field}:${proposal.tag}`;
  if (meetsConfidence(proposal.confidence, threshold)) return { ...proposal, label, decision: "adopt", reason: `confidence '${proposal.confidence}' meets the auto-adopt threshold '${threshold}' (title/instrument-key identity match).` };
  const vocab = heldVocabulary(opts.adopted)[proposal.field];
  if (!vocab?.has(proposal.tag)) return { ...proposal, label, decision: "decline", reason: `tag "${proposal.tag}" is not in the live closed vocabulary for ${proposal.field}.` };
  if (!evidencePresentInItemText(proposal.evidence, item)) return { ...proposal, label, decision: "decline", reason: `keyword evidence "${proposal.evidence}" was not found in the item's own title, what_is_it, summary, or full_brief.` };
  return { ...proposal, label, decision: "adopt", reason: `confidence '${proposal.confidence}': tag is in the closed vocabulary for ${proposal.field} and keyword evidence "${proposal.evidence}" is re-confirmed present in the item's own text.` };
}

export interface MergePatch {
  patch: Partial<Record<TagField, string[]>>;
  added: Partial<Record<TagField, string[]>>;
  cappedOut: Partial<Record<TagField, string[]>>;
  alreadyPresent: Partial<Record<TagField, string[]>>;
  blockedByCorrection: Partial<Record<TagField, string[]>>;
}

/** The merge-only column patch: existing tags stay, novel adopted ones are appended up to the field cap, removed tags are blocked. */
function buildMergePatch(item: Partial<TaggedItem>, proposals: readonly Pick<TagProposal, "field" | "tag">[], removed?: Partial<Record<string, Set<string>>>): MergePatch {
  const out: MergePatch = { patch: {}, added: {}, cappedOut: {}, alreadyPresent: {}, blockedByCorrection: {} };
  for (const field of TAG_FIELDS) {
    const existing = Array.isArray(item?.[field]) ? (item[field] as string[]) : [];
    const existingSet = new Set(existing);
    const gone = removed?.[field];
    const all = proposals.filter((p) => p.field === field).map((p) => p.tag);
    const blocked = gone ? all.filter((t) => gone.has(t)) : [];
    if (blocked.length) out.blockedByCorrection[field] = [...new Set(blocked)];
    const candidates = gone ? all.filter((t) => !gone.has(t)) : all;
    const novel: string[] = [];
    const dupe: string[] = [];
    const seen = new Set<string>();
    for (const tag of candidates) {
      if (existingSet.has(tag) || seen.has(tag)) dupe.push(tag);
      else {
        seen.add(tag);
        novel.push(tag);
      }
    }
    const room = Math.max(0, FIELD_CAPS[field] - existing.length);
    const toAdd = novel.slice(0, room);
    if (toAdd.length) {
      out.patch[field] = [...existing, ...toAdd];
      out.added[field] = toAdd;
    }
    if (novel.length > room) out.cappedOut[field] = novel.slice(room);
    if (dupe.length) out.alreadyPresent[field] = dupe;
  }
  return out;
}

const buildNoDerivableTagsNote = (today: Date): string =>
  `no derivable tags from the item's own text on ${today.toISOString().slice(0, 10)} (keyword vocabulary); the item joins the connection graph through its entity refs; no manual tagging (ADR-030)`;

export interface AdoptResult {
  itemId: string;
  decisions: DecidedProposal[];
  merge: MergePatch;
  blockedByCorrection: number;
  wrote: boolean;
  flagWritten: boolean;
  notes: string[];
}

/**
 * Derive-and-decide for one item: filter out the tags an admin removed, decide the rest by rule, write the merged tag columns (the only item write),
 * and record the decision as a flag born resolved (deduped on item and namespace, any status). A failed write is reported in `notes`, never swallowed.
 */
export async function adoptTags(sb: Db, item: TaggedItem, proposals: readonly TagProposal[], opts: { now: Date; adopted?: Partial<AdoptedVocabulary>; dry?: boolean; threshold?: Confidence; corrections?: Awaited<ReturnType<typeof readItemCorrections>> }): Promise<AdoptResult> {
  const notes: string[] = [];
  const corrections = opts.corrections ?? (await readItemCorrections(sb, item.id));
  const removed = removedTagsFor(corrections, item.id);
  const { kept, blocked } = filterTagProposals(proposals, removed);
  const decisions = kept.map((p) => decideTagProposal(p, item, { ...(opts.threshold ? { threshold: opts.threshold } : {}), ...(opts.adopted ? { adopted: opts.adopted } : {}) }));
  const merge = buildMergePatch(item, decisions.filter((d) => d.decision === "adopt"), removed);
  const hasWrite = Object.keys(merge.patch).length > 0;
  const result: AdoptResult = { itemId: item.id, decisions, merge, blockedByCorrection: blocked.length, wrote: false, flagWritten: false, notes };
  if (opts.dry) return result;
  if (hasWrite) {
    const { error } = await sb.from("intelligence_items").update(merge.patch).eq("id", item.id);
    if (error) notes.push(`tag write failed for ${item.id}: ${error.message}`);
    else result.wrote = true;
  }
  const subjectRef = buildSubjectRef(item.id);
  const by = createdBy(TAG_NAMESPACE, DECISION_SUBTYPE);
  const prior = await sb.from("integrity_flags").select("id").eq("subject_ref", subjectRef).eq("created_by", by).limit(1);
  if (prior.error) notes.push(`flag dedupe read failed for ${item.id}: ${prior.error.message}`);
  else if (!(prior.data ?? []).length) {
    const note = decisions.length ? buildDecisionNote("tag decision (rule, threshold high)", decisions) : buildNoDerivableTagsNote(opts.now);
    const ins = await sb.from("integrity_flags").insert({
      category: "data_quality", subject_type: "item", subject_ref: subjectRef,
      description: `Tags for item ${item.id} decided by rule: ${decisions.length} proposal(s), ${decisions.filter((d) => d.decision === "adopt").length} adopted.`.slice(0, 480),
      recommended_actions: [], status: "resolved", resolved_at: opts.now.toISOString(), resolved_by: "tag-pass", resolution_note: note, created_by: by,
    });
    if (ins.error) notes.push(`decision flag not written for ${item.id}: ${ins.error.message}`);
    else result.flagWritten = true;
  }
  return result;
}
