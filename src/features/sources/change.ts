// Ported from old_repo/src/lib/sources/amendment-diff.mjs (lines 1-143)
// Ported from old_repo/src/lib/sources/reconcile.ts (lines 1-213)
// Ported from old_repo/src/lib/sources/change-sweep.mjs (lines 68-176)
import type { Db } from "@/core/db";
import { outcomeOf, type RunDeps, type RunResult } from "@/core/sources/run-result";

import { detectPublisherShape, extractCleanText, type PublisherShape } from "./holdings-audit";
import { readSnapshotBody } from "./snapshots";

const SHAPE_MARKERS: Record<string, RegExp> = {
  "eur-lex": /\bArticle\s+(\d+[a-z]?)\b/gi,
  "legislation.gov.uk": /\b(?:Regulation|Section|Article|Paragraph)\s+(\d+[A-Z]?)\b/gi,
  "federal-register": /(?:§\s*(\d+\.\d+[a-z]?)|\bSec(?:tion|\.)\s+(\d+[a-z]?)\b)/gi,
  gazette: /\b(?:Article|Art\.|Art[íi]culo|Articolo|Section|Paragraph|§)\s+(\d+[a-z]?)\b/gi,
  other: /\b(?:Article|Section|Paragraph|Clause|Rule)\s+(\d+[a-z]?)\b/gi,
};
export interface Segment {
  key: string;
  body: string;
  hash: string;
}
/** A cheap deterministic FNV-1a over the normalised text (lower-cased, whitespace-collapsed, punctuation-trimmed). */
function normHash(s: unknown): string {
  const norm = String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[^\w ]+/g, "").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const provisionLabel = (shape: string) => (shape === "legislation.gov.uk" ? "Section" : shape === "federal-register" ? "Sec." : "Article");

/** Segment a document into provisions by publisher shape; no recognisable provision gives one "whole" segment. A duplicate key (a TOC entry and the enacting one) keeps the longer body. */
function segmentByShape(text: string, shape: string): Segment[] {
  const clean = extractCleanText(text);
  if (!clean) return [];
  const re = new RegExp((SHAPE_MARKERS[shape] ?? SHAPE_MARKERS.other)!.source, "gi");
  const marks: Array<{ key: string; at: number }> = [];
  for (let m = re.exec(clean); m; m = re.exec(clean)) marks.push({ key: `${provisionLabel(shape)} ${m[1] || m[2] || ""}`.trim(), at: m.index });
  if (!marks.length) return [{ key: "whole", body: clean, hash: normHash(clean) }];
  const segs: Segment[] = [];
  if ((marks[0]?.at ?? 0) > 40) {
    const pre = clean.slice(0, marks[0]?.at).trim();
    if (pre) segs.push({ key: "preamble", body: pre, hash: normHash(pre) });
  }
  marks.forEach((mk, i) => {
    const body = clean.slice(mk.at, i + 1 < marks.length ? marks[i + 1]?.at : clean.length).trim();
    const existing = segs.find((s) => s.key === mk.key);
    if (existing) {
      if (body.length > existing.body.length) Object.assign(existing, { body, hash: normHash(body) });
    } else segs.push({ key: mk.key, body, hash: normHash(body) });
  });
  return segs;
}
/** Sentence-level set difference between two provision bodies. */
function segmentTextDiff(prevBody: string, nextBody: string) {
  const sents = (s: string) => String(s || "").split(/(?<=[.;:])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 3);
  const pv = new Map(sents(prevBody).map((s) => [normHash(s), s]));
  const nx = new Map(sents(nextBody).map((s) => [normHash(s), s]));
  return { added: [...nx].filter(([h]) => !pv.has(h)).map(([, s]) => s), removed: [...pv].filter(([h]) => !nx.has(h)).map(([, s]) => s) };
}
/** Align two provision lists by key and hash: unchanged, changed (with the sentence diff), added, removed. */
function alignSegments(prev: Segment[], next: Segment[]) {
  const pv = new Map(prev.map((s) => [s.key, s]));
  const nx = new Map(next.map((s) => [s.key, s]));
  const unchanged: Array<{ key: string }> = [];
  const changed: Array<{ key: string; prev: string; next: string; diff: ReturnType<typeof segmentTextDiff> }> = [];
  const added: Array<{ key: string; body: string }> = [];
  const removed: Array<{ key: string; body: string }> = [];
  for (const [key, ns] of nx) {
    const ps = pv.get(key);
    if (!ps) added.push({ key, body: ns.body });
    else if (ps.hash === ns.hash) unchanged.push({ key });
    else changed.push({ key, prev: ps.body, next: ns.body, diff: segmentTextDiff(ps.body, ns.body) });
  }
  for (const [key, ps] of pv) if (!nx.has(key)) removed.push({ key, body: ps.body });
  return { unchanged, changed, added, removed };
}
function diffDocuments(prevText: string, nextText: string, opts: { url?: string; shape?: PublisherShape } = {}) {
  const shape = opts.shape || detectPublisherShape(opts.url);
  const prev = segmentByShape(prevText, shape);
  const next = segmentByShape(nextText, shape);
  const align = alignSegments(prev, next);
  return { shape, counts: { prev_provisions: prev.length, next_provisions: next.length, unchanged: align.unchanged.length, changed: align.changed.length, added: align.added.length, removed: align.removed.length }, ...align };
}

export type ChangeType = "new" | "status_change" | "deadline_change" | "scope_change" | "penalty_change" | "provision_added" | "provision_amended" | "administrative";
export type ChangeSeverity = "critical" | "significant" | "minor" | "administrative";
export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}
/** The changed fields between two item snapshots. */
function computeDiff(previous: Record<string, unknown>, next: Record<string, unknown>): FieldDiff[] {
  const fields = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  return [...fields].filter((f) => JSON.stringify(previous?.[f]) !== JSON.stringify(next?.[f])).map((field) => ({ field, from: previous?.[field], to: next?.[field] }));
}
/** (change_type, severity) from which fields moved, most consequential first; both are the intelligence_changes CHECK vocabularies. */
function classifyChange(diff: FieldDiff[]): { changeType: ChangeType; severity: ChangeSeverity } {
  const f = new Set(diff.map((d) => d.field));
  if (f.has("status")) return { changeType: "status_change", severity: "critical" };
  if (f.has("compliance_deadline") || f.has("entry_into_force") || f.has("next_review_date")) return { changeType: "deadline_change", severity: "critical" };
  if (f.has("penalty") || f.has("penalties") || f.has("penalty_amount")) return { changeType: "penalty_change", severity: "significant" };
  if (f.has("jurisdictions") || f.has("jurisdiction_iso") || f.has("scope")) return { changeType: "scope_change", severity: "significant" };
  if (f.has("full_brief")) return { changeType: "provision_amended", severity: "significant" };
  if (f.has("title") || f.has("summary")) return { changeType: "administrative", severity: "minor" };
  return { changeType: "administrative", severity: "administrative" };
}
/** Write one intelligence_changes record (changeTypeOverride 'new' for a newly minted item). The result is read. */
export async function recordItemChange(db: Db, args: { itemId: string; previous: Record<string, unknown>; next: Record<string, unknown>; changeTypeOverride?: ChangeType }) {
  const diff = computeDiff(args.previous, args.next);
  const derived = classifyChange(diff);
  const changeType = args.changeTypeOverride ?? derived.changeType;
  const severity = args.changeTypeOverride === "new" ? "significant" : derived.severity;
  const change_summary = changeType === "new" ? "item created" : diff.length ? `${changeType}: ${diff.map((d) => d.field).join(", ")}` : "no field change";
  const { data, error } = await db.from("intelligence_changes").insert({ item_id: args.itemId, change_type: changeType, change_severity: severity, previous_value: args.previous, new_value: args.next, change_summary, raw_diff: JSON.stringify(diff) }).select("id").single();
  return { ok: !error, severity, changeType, changeId: (data as { id: string } | null)?.id, error: error?.message };
}
/** The lightweight "a source changed, this item is flagged for re-grounding" event; provision_amended is the closest real CHECK value. */
async function recordSourceChangeTrigger(db: Db, args: { itemId: string; sourceUrl: string | null }) {
  const { data, error } = await db.from("intelligence_changes").insert({ item_id: args.itemId, change_type: "provision_amended", change_severity: "significant", previous_value: null, new_value: null, change_summary: `source content changed (${args.sourceUrl ?? "unknown url"}): item flagged for re-grounding`, raw_diff: null }).select("id").single();
  return { ok: !error, changeId: (data as { id: string } | null)?.id, error: error?.message };
}

/** The `reason` prefix every row the bridge stages carries; the ONE marker a consumer matches on (proposed_changes is always empty). */
const CHANGE_SWEEP_STAGED_MARKER = "[change-sweep]";
/** The bridge's per-source cap, exported once (the reconcile dry projection reads the same bound). */
const BRIDGE_DEFAULT_LIMIT = 50;
function summarizeAmendmentDiff(diff: ReturnType<typeof diffDocuments>): string {
  const { added, changed, removed } = diff.counts;
  return !added && !changed && !removed ? `amendment diff: no provision-level change detected (shape=${diff.shape})` : `amendment diff: ${added} provision(s) added, ${changed} changed, ${removed} removed (shape=${diff.shape})`;
}
const fingerprintChangedNote = (sourceUrl: string | null | undefined): string => `source content fingerprint changed (${sourceUrl ?? "unknown source"}): fewer than two stored captures to diff; provision-level detail unavailable until the next capture`;

/**
 * Stage ONE update_item staged_updates row per LIVE item of a changed source, with an amendment-diff summary in `reason` (the two newest stored captures when both exist).
 * It proposes no content (proposed_changes stays empty). Bounded, and the drop is reported. Every read throws on error; a failed insert is reported per item.
 */
async function bridgeChangedSourceToStagedUpdates(db: Db, { sourceId, items, limit = BRIDGE_DEFAULT_LIMIT }: { sourceId: string; items: Array<{ id: string }>; limit?: number }) {
  const live = (items ?? []).slice(0, limit);
  const notBridged = (items ?? []).length > limit ? items.length - limit : 0;
  if (!live.length) return { sourceId, summary: null, confidence: null, staged: 0, notBridged, errors: [] as string[] };
  const src = await db.from("sources").select("url").eq("id", sourceId).maybeSingle();
  if (src.error) throw new Error(`[change-sweep] source read failed for ${sourceId}: ${src.error.message}`);
  const sourceUrl = (src.data as { url?: string } | null)?.url ?? null;
  const snaps = await db.from("raw_fetches").select("file_path, fetched_at").eq("source_id", sourceId).order("fetched_at", { ascending: false }).limit(2);
  if (snaps.error) throw new Error(`[change-sweep] snapshot read failed: ${snaps.error.message}`);
  let summary = fingerprintChangedNote(sourceUrl);
  let confidence = "LOW";
  const pair = (snaps.data ?? []) as Array<{ file_path: string }>;
  if (pair.length === 2) {
    try {
      const [nextBody, prevBody] = await Promise.all([readSnapshotBody(db, pair[0]!.file_path), readSnapshotBody(db, pair[1]!.file_path)]);
      summary = summarizeAmendmentDiff(diffDocuments(prevBody, nextBody, sourceUrl ? { url: sourceUrl } : {}));
      confidence = "MEDIUM";
    } catch (e) {
      summary = `${fingerprintChangedNote(sourceUrl)} (diff attempt failed: ${(e as Error).message})`;
    }
  }
  const errors: string[] = [];
  let staged = 0;
  for (const item of live) {
    const { error } = await db.from("staged_updates").insert({ item_id: item.id, source_id: sourceId, update_type: "update_item", proposed_changes: {}, reason: `${CHANGE_SWEEP_STAGED_MARKER} ${summary}`, source_url: sourceUrl, confidence });
    if (error) errors.push(`item ${item.id}: ${error.message}`);
    else staged++;
  }
  return { sourceId, summary, confidence, staged, notBridged, errors };
}

const RECONCILE_BATCH = 200;
/**
 * The reconcile pass: claim pending monitoring_queue rows (change_detected, not reconciled), record the source-changed trigger for every LIVE item on the source, bridge the
 * same items into staged_updates, then stamp reconciled_at. `dry` projects the counts and writes nothing. A queue read failure fails the pass (never an empty queue); a per-row failure is recorded and the pass continues.
 */
export async function reconcileChanges(deps: RunDeps, input: { batch?: number; dry?: boolean } = {}): Promise<RunResult> {
  const { db, now } = deps;
  const dry = input.dry ?? false;
  const notes: string[] = [];
  const pending = await db.from("monitoring_queue").select("id, source_id, checked_at").eq("change_detected", true).is("reconciled_at", null).order("checked_at", { ascending: true }).limit(input.batch ?? RECONCILE_BATCH);
  if (pending.error) return { counts: { processed: 0, changes_recorded: 0, staged: 0, pending: 0 }, outcome: "failed", notes: [`queue read failed: ${pending.error.message}`] };
  const rows = (pending.data ?? []) as Array<{ id: string; source_id: string }>;
  let processed = 0;
  let changes = 0;
  let staged = 0;
  let failed = 0;
  for (const row of rows) {
    const items = await db.from("intelligence_items").select("id, source_url").eq("source_id", row.source_id).eq("is_archived", false);
    if (items.error) {
      notes.push(`items read for source ${row.source_id}: ${items.error.message}`);
      failed++;
      continue;
    }
    const live = (items.data ?? []) as Array<{ id: string; source_url: string | null }>;
    if (dry) {
      changes += live.length;
      staged += Math.min(live.length, BRIDGE_DEFAULT_LIMIT);
      processed++;
      continue;
    }
    for (const item of live) {
      const r = await recordSourceChangeTrigger(db, { itemId: item.id, sourceUrl: item.source_url });
      if (r.ok) changes++;
      else notes.push(`item ${item.id.slice(0, 8)}: ${r.error}`);
    }
    if (live.length) {
      try {
        const bridged = await bridgeChangedSourceToStagedUpdates(db, { sourceId: row.source_id, items: live });
        staged += bridged.staged;
        for (const e of bridged.errors) notes.push(`bridge source ${row.source_id}: ${e}`);
      } catch (e) {
        notes.push(`bridge source ${row.source_id}: ${(e as Error).message}`);
      }
    }
    const { error } = await db.from("monitoring_queue").update({ reconciled_at: now().toISOString() }).eq("id", row.id);
    if (error) {
      notes.push(`queue ${row.id}: ${error.message}`);
      failed++;
    } else processed++;
  }
  return { counts: { processed, changes_recorded: changes, staged, pending: rows.length }, outcome: outcomeOf(processed, failed), notes: notes.slice(0, 20) };
}
