// Ported from old_repo/src/lib/sources/bias-tag-pipeline.mjs (lines 1-152)
// Ported from old_repo/src/lib/credibility/bias-display.mjs (lines 1-128)
// Ported from old_repo/src/lib/credibility/chip-selection.mjs (lines 1-39)
import { z } from "zod";

import raw from "./data/bias-tags.json";

const V = z
  .object({
    dimensions: z.array(z.object({ dimension: z.enum(["funding", "methodology", "stakeholder"]), label: z.string(), tags: z.array(z.object({ tag: z.string(), label: z.string() })) })),
    adoptThreshold: z.number(),
    lowerConfidenceBelow: z.number(),
    assignmentSource: z.string(),
  })
  .parse(raw);

export type BiasDimension = "funding" | "methodology" | "stakeholder";
const DIMENSIONS: BiasDimension[] = V.dimensions.map((d) => d.dimension);
const BIAS_TAG_VOCAB: Readonly<Record<BiasDimension, readonly string[]>> = Object.fromEntries(V.dimensions.map((d) => [d.dimension, d.tags.map((t) => t.tag)])) as Record<BiasDimension, string[]>;
const BIAS_TAG_LABELS: Readonly<Record<string, string>> = Object.fromEntries(V.dimensions.flatMap((d) => d.tags.map((t) => [t.tag, t.label])));

/** A tag at or above this confidence is high confidence; the 0.65 to 0.79 band is adopted and shown as lower confidence. */
const HIGH_CONFIDENCE_THRESHOLD = V.lowerConfidenceBelow;
export const LOWER_CONFIDENCE_WORDS = "lower confidence";

export interface BiasRow {
  dimension: BiasDimension;
  tag: string;
  confidence: number;
  assignment_source: string;
}
export interface BiasDiscard {
  dimension: string | null;
  tag: unknown;
  confidence: unknown;
  reason: string;
}

/**
 * Splits a recommendation object { funding?: {tag, confidence}[], methodology?, stakeholder? } into rows to insert (one adoption band, 0.65 and up) and
 * discards that each carry a reason. Never throws on malformed input: a bad session-authored response must not crash the approval flow that calls this.
 */
function splitBiasTags(biasTags: unknown): { insertRows: BiasRow[]; discarded: BiasDiscard[] } {
  const insertRows: BiasRow[] = [];
  const discarded: BiasDiscard[] = [];
  if (biasTags === null || biasTags === undefined) return { insertRows, discarded };
  if (typeof biasTags !== "object" || Array.isArray(biasTags)) return { insertRows, discarded: [{ dimension: null, tag: null, confidence: null, reason: "bias_tags is not an object" }] };
  const obj = biasTags as Record<string, unknown>;
  for (const dimension of DIMENSIONS) {
    const entries = obj[dimension];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      discarded.push({ dimension, tag: null, confidence: null, reason: "dimension value is not an array" });
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        discarded.push({ dimension, tag: null, confidence: null, reason: "entry is not an object" });
        continue;
      }
      const { tag, confidence } = entry as { tag?: unknown; confidence?: unknown };
      if (typeof tag !== "string" || !BIAS_TAG_VOCAB[dimension].includes(tag)) discarded.push({ dimension, tag, confidence, reason: "off-vocabulary tag" });
      else if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) discarded.push({ dimension, tag, confidence, reason: "invalid confidence" });
      else if (confidence >= V.adoptThreshold) insertRows.push({ dimension, tag, confidence, assignment_source: V.assignmentSource });
      else discarded.push({ dimension, tag, confidence, reason: `below ${V.adoptThreshold} threshold` });
    }
  }
  for (const key of Object.keys(obj)) if (!(DIMENSIONS as string[]).includes(key)) discarded.push({ dimension: key, tag: null, confidence: null, reason: "unknown dimension key" });
  return { insertRows, discarded };
}

/** Insert the qualifying rows through the injected writer; a writer error throws (the insert is not skipped silently). */
export async function writeBiasTags(deps: { insertRows: (rows: object[]) => Promise<{ error?: { message: string } | null }> }, sourceId: string, biasTags: unknown): Promise<{ inserted: number; discarded: BiasDiscard[] }> {
  if (!sourceId) throw new Error("writeBiasTags requires a sourceId");
  const { insertRows, discarded } = splitBiasTags(biasTags);
  if (insertRows.length === 0) return { inserted: 0, discarded };
  const { error } = await deps.insertRows(insertRows.map((r) => ({ source_id: sourceId, ...r })));
  if (error) throw new Error(`bias-tag insert failed: ${error.message}`);
  return { inserted: insertRows.length, discarded };
}

/** A label for a stored tag; a tag outside the vocabulary is humanized from its slug, so display never throws on drift. */
export function biasTagLabel(tag: unknown): string {
  const key = String(tag ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(BIAS_TAG_LABELS, key)) return BIAS_TAG_LABELS[key] ?? key;
  const spaced = key.replace(/[-_]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}
const isLowerConfidence = (confidence: unknown): boolean => typeof confidence === "number" && Number.isFinite(confidence) && confidence < HIGH_CONFIDENCE_THRESHOLD;

export interface BiasTagInput {
  dimension: string;
  tag: string;
  confidence?: number | null | undefined;
}
export interface BiasChip {
  key: string;
  tag: string;
  dimension: BiasDimension | null;
  label: string;
  lowerConfidence: boolean;
  confidencePct: number | null;
}
const toChip = (t: BiasTagInput): BiasChip => ({
  key: `${t.dimension}:${t.tag}`,
  tag: String(t.tag),
  dimension: (DIMENSIONS as string[]).includes(t.dimension) ? (t.dimension as BiasDimension) : null,
  label: biasTagLabel(t.tag),
  lowerConfidence: isLowerConfidence(t.confidence),
  confidencePct: typeof t.confidence === "number" && Number.isFinite(t.confidence) ? Math.round(t.confidence * 100) : null,
});

/** The display model for one source's tags: the top `maxChips` by confidence, then dimension order, then tag; the rest behind the disclosure. Non-positive shows all. */
export function biasChips(tags: BiasTagInput[] | null | undefined, maxChips?: number) {
  const usable = (Array.isArray(tags) ? tags : []).filter((t) => t && typeof t.tag === "string" && t.tag.trim() !== "" && (DIMENSIONS as string[]).includes(t.dimension));
  if (usable.length === 0) return { shown: [] as BiasChip[], rest: [] as BiasChip[], remaining: 0, total: 0 };
  if (typeof maxChips !== "number" || maxChips <= 0 || usable.length <= maxChips) return { shown: usable.map(toChip), rest: [] as BiasChip[], remaining: 0, total: usable.length };
  const order = (d: string) => DIMENSIONS.indexOf(d as BiasDimension);
  const sorted = [...usable].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || order(a.dimension) - order(b.dimension) || String(a.tag).localeCompare(String(b.tag)));
  const displayed = sorted.slice(0, maxChips);
  const rest = usable.filter((t) => !displayed.includes(t)).map(toChip).sort((a, b) => a.key.localeCompare(b.key));
  return { shown: displayed.map(toChip), rest, remaining: usable.length - maxChips, total: usable.length };
}
export const hasBiasTags = (tags: BiasTagInput[] | null | undefined): boolean => biasChips(tags, 1).total > 0;

/** The whole vocabulary grouped by dimension with labels, for a legend; built from the data, never typed per page. */
export const biasLegend = () => V.dimensions.map((d) => ({ dimension: d.dimension, label: d.label, tags: d.tags.map((t) => ({ tag: t.tag, label: t.label })) }));
