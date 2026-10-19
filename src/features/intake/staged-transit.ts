// Ported from old_repo/src/lib/intake/apply-staged-update.ts (lines 24-44)
// Ported from old_repo/src/lib/intake/apply-staged-update.ts (lines 46-99)
// Ported from old_repo/src/lib/intake/apply-staged-update.ts (lines 194-344)
// Ported from old_repo/src/lib/intake/run-intake-cycle.ts (lines 358-412)
// Ported from old_repo/src/lib/sources/entity-gate.mjs (lines 5-15)
// Staged updates are TRANSIT-ONLY and machine-gated (RD-20): a staged row is materialised or rejected with a reason and never parks.
// `applyStagedUpdate` materialises one by update_type. Differences from the old writer, each a closed defect: update_item writes ONLY
// an allowlisted set of columns (it once wrote any key in the staged row, including provenance-adjacent ones, B-0059) and an empty patch
// is refused as a no-op; new_source goes through the registry (role and tier at birth, deduped) instead of a raw insert; every
// disposition stamp is checked and its failure reported (B-0062, B-0564, B-1990); the substantive-update flywheel step list is shared
// with the mint (flywheel-participation.ts). No `intelligence_items` INSERT exists here: a new_item goes through deps.mint (INV-169).
import { z } from "zod";

import { DB_FORMAT_TYPE_VALUES, DB_PRIORITY_VALUES, DB_SEVERITY_VALUES, DB_URGENCY_TIER_VALUES } from "@/core/brief/vocab";
import type { Db } from "@/core/db";

import staged from "./data/staged.json";
import { MINT_OK, type IntakeDeps } from "./deps";
import { runParticipation } from "./flywheel-participation";

const names = z.array(z.string());
const cfg = z.object({
  nonSubstantive: names, contentColumns: names, chokepointOnlyInputs: names, archiveColumns: names, changeSweepMarker: z.string(),
  columnTypes: z.object({ text: names, textArray: names, date: names, sourceDate: names, timestamp: names, bool: names, uuid: names, uuidArray: names, json: names }),
  enums: z.object({ status: names, confidence: names }),
}).parse(staged);
const NON_SUBSTANTIVE: ReadonlySet<string> = new Set(cfg.nonSubstantive);
/** update_item may write these columns and no others: the content columns plus the bookkeeping columns. */
const UPDATE_ITEM_ALLOWLIST: ReadonlySet<string> = new Set([...cfg.contentColumns, ...cfg.nonSubstantive]);
const CHOKEPOINT_ONLY: ReadonlySet<string> = new Set(cfg.chokepointOnlyInputs);
export const CHANGE_SWEEP_STAGED_MARKER = cfg.changeSweepMarker;

export interface StagedUpdateRow { id?: string; item_id?: string | null; update_type: string; proposed_changes: Record<string, unknown> | null }
export interface ApplyUpdateResult { success: boolean; error?: string; itemId?: string; flags?: string[]; action?: string }

/**
 * True when the patch touches at least one column outside the non-substantive (bookkeeping) set. A DENY list: a column nobody has heard
 * of counts as substantive, so the flywheel runs on it rather than silently skipping. An empty patch touches nothing.
 */
function isSubstantiveUpdate(proposed: Record<string, unknown> | null | undefined): boolean {
  const keys = Object.keys(proposed ?? {});
  return keys.length > 0 && keys.some((k) => !NON_SUBSTANTIVE.has(k));
}

const LANDING_SEGMENT = /^(en|en-us|en-gb|fr|de|es|pt|it|home|index(\.[a-z0-9]+)?|default(\.[a-z0-9]+)?|main|portal|start|welcome)$/i;
/** Entity gate: is this URL a portal root or a trivial landing page (a SOURCE, not an item)? A deep path is a specific document. */
function isRootUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  return segs.length === 0 || (segs.length === 1 && !u.search && LANDING_SEGMENT.test(segs[0] ?? ""));
}

/** A new_item seed: the chokepoint-only inputs (relevance, capturedText, key_deadlines, source_name, authority_level) are not columns and never reach the INSERT. */
function splitNewItemSeed(proposed: Record<string, unknown>): { seed: Record<string, unknown>; relevance: number | null } {
  const seed = Object.fromEntries(Object.entries(proposed).filter(([k]) => !CHOKEPOINT_ONLY.has(k)));
  return { seed, relevance: typeof proposed.relevance === "number" ? proposed.relevance : null };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDay = (v: unknown): boolean => typeof v === "string" && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const ENUMS: Readonly<Record<string, ReadonlySet<string>>> = { status: new Set(cfg.enums.status), confidence: new Set(cfg.enums.confidence), priority: DB_PRIORITY_VALUES, severity: DB_SEVERITY_VALUES, urgency_tier: DB_URGENCY_TIER_VALUES, format_type: DB_FORMAT_TYPE_VALUES };
type Check = (v: unknown) => boolean;
/** The column types of the allowlist, as predicates: a value of the wrong type is a refusal naming the column, never a coercion. */
const TYPE_OF = new Map<string, Check>([
  ...cfg.columnTypes.text.map((c): [string, Check] => [c, (v) => typeof v === "string"]),
  ...cfg.columnTypes.textArray.map((c): [string, Check] => [c, (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "")]),
  ...[...cfg.columnTypes.date, ...cfg.columnTypes.sourceDate].map((c): [string, Check] => [c, isDay]),
  ...cfg.columnTypes.timestamp.map((c): [string, Check] => [c, (v) => typeof v === "string" && !Number.isNaN(Date.parse(v))]),
  ...cfg.columnTypes.bool.map((c): [string, Check] => [c, (v) => typeof v === "boolean"]),
  ...cfg.columnTypes.uuid.map((c): [string, Check] => [c, (v) => typeof v === "string" && UUID.test(v)]),
  ...cfg.columnTypes.uuidArray.map((c): [string, Check] => [c, (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && UUID.test(x))]),
  ...cfg.columnTypes.json.map((c): [string, Check] => [c, (v) => v !== undefined]),
  ...Object.entries(ENUMS).map(([c, set]): [string, Check] => [c, (v) => typeof v === "string" && set.has(v)]),
]);
const SOURCE_DATES: ReadonlySet<string> = new Set(cfg.columnTypes.sourceDate);
const ARCHIVE_ONLY: ReadonlySet<string> = new Set(cfg.archiveColumns);

export type StagedKind = "update_item" | "status_change" | "archive_item";
export interface StagedPatch { patch: Record<string, unknown>; evidence: Record<string, { capture_id: string; span: string }> }
/**
 * The typed parse of a staged item patch (fail closed): the patch is non-empty, every column is on the allowlist and of its type (a null clears), the kind writes only its own columns, and a source date that is set
 * (not cleared) carries `date_evidence[column] = { capture_id, span }`. Whether that span is verbatim in a capture of the item is checked by the database in the write itself.
 */
function parseStagedPatch(kind: StagedKind, proposed: Record<string, unknown>): { ok: true; value: StagedPatch } | { ok: false; error: string } {
  const { date_evidence: rawEvidence, ...patch } = proposed;
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, error: "empty patch refused: nothing to write" };
  const refused = keys.filter((k) => !UPDATE_ITEM_ALLOWLIST.has(k));
  if (refused.length) return { ok: false, error: `update_item refused: column(s) outside the allowlist: ${refused.join(", ")}` };
  if (kind === "status_change" && keys.some((k) => k !== "status")) return { ok: false, error: "status_change writes the status column alone" };
  if (kind === "archive_item" && keys.some((k) => !ARCHIVE_ONLY.has(k))) return { ok: false, error: "archive_item writes the archive columns alone" };
  const wrong = keys.filter((k) => patch[k] !== null && !(TYPE_OF.get(k)?.(patch[k]) ?? false));
  if (wrong.length) return { ok: false, error: `staged value of the wrong type or outside its vocabulary: ${wrong.join(", ")}` };
  const evidence: StagedPatch["evidence"] = {};
  for (const k of keys.filter((c) => SOURCE_DATES.has(c) && patch[c] !== null)) {
    const e = (rawEvidence as Record<string, { capture_id?: unknown; span?: unknown }> | null | undefined)?.[k];
    if (!e || typeof e.capture_id !== "string" || !UUID.test(e.capture_id) || typeof e.span !== "string" || e.span.trim().length < 8) return { ok: false, error: `${k} is a date from a source: it needs date_evidence.${k} = { capture_id, span } naming a verbatim span of a capture of the item` };
    evidence[k] = { capture_id: e.capture_id, span: e.span };
  }
  return { ok: true, value: { patch, evidence } };
}
/** The one door to the item row (apply_staged_item_patch): one locked statement, the evidence re-checked in the database. */
async function writePatch(sb: Db, itemId: string, kind: StagedKind, v: StagedPatch): Promise<string | null> {
  const { error } = await sb.rpc("apply_staged_item_patch", { p_item_id: itemId, p_kind: kind, p_patch: v.patch, p_evidence: v.evidence });
  return error ? error.message : null;
}

/** Materialise one staged row. Never throws; every failure is a returned reason. */
export async function applyStagedUpdate(deps: IntakeDeps, update: StagedUpdateRow, opts: { dry?: boolean } = {}): Promise<ApplyUpdateResult> {
  const { sb } = deps;
  const proposed = (update.proposed_changes ?? {}) as Record<string, unknown>;
  try {
    switch (update.update_type) {
      case "new_item": {
        if (typeof update.proposed_changes !== "object") return { success: false, error: "proposed_changes is not an object" };
        const { seed, relevance } = splitNewItemSeed(proposed);
        if (typeof seed.source_url === "string" && isRootUrl(seed.source_url)) return { success: false, error: `entity-gate: ${seed.source_url} is a portal root URL: a source, not an item; not materialized` };
        const res = await deps.mint.mintItem({ seed, legacyId: typeof seed.legacy_id === "string" ? seed.legacy_id : null, relevance, origin: "staged_materialization" }, { dry: opts.dry === true });
        return MINT_OK.includes(res.outcome) && (res.itemId || opts.dry) ? { success: true, ...(res.itemId ? { itemId: res.itemId } : {}), flags: res.reasons, action: res.outcome } : { success: false, error: res.reasons.at(-1) ?? `mint refused: ${res.outcome}`, flags: res.reasons, action: res.outcome };
      }
      case "update_item": {
        if (!update.item_id) return { success: false, error: "No item_id for update" };
        const parsed = parseStagedPatch("update_item", proposed);
        if (!parsed.ok) return { success: false, error: parsed.error };
        if (opts.dry) return { success: true, itemId: update.item_id, flags: [] };
        const err = await writePatch(sb, update.item_id, "update_item", parsed.value);
        if (err) return { success: false, error: err };
        const keys = Object.keys(parsed.value.patch);
        const flags: string[] = [];
        if (isSubstantiveUpdate(parsed.value.patch)) {
          const r = await runParticipation({ sb, connect: deps.connect, now: () => deps.recorder.now() }, { itemId: update.item_id, context: "update", changed: keys });
          flags.push(...r.flags);
        }
        return { success: true, itemId: update.item_id, flags };
      }
      case "status_change": {
        if (!update.item_id) return { success: false, error: "No item_id for status change" };
        if (!proposed.status) return { success: false, error: "proposed_changes.status missing" };
        const parsed = parseStagedPatch("status_change", { status: proposed.status });
        if (!parsed.ok) return { success: false, error: parsed.error };
        if (opts.dry) return { success: true, itemId: update.item_id };
        const err = await writePatch(sb, update.item_id, "status_change", parsed.value);
        return err ? { success: false, error: err } : { success: true, itemId: update.item_id };
      }
      case "new_source": {
        const url = typeof proposed.url === "string" ? proposed.url : "";
        if (!url) return { success: false, error: "new_source needs a url" };
        if (opts.dry) return { success: true };
        const r = await deps.sources.registerAndRate(url);
        return r.sourceId ? { success: true, flags: [`source:${r.sourceId}`] } : { success: false, error: `source not registered${r.refused ? `: ${r.refused}` : ""}` };
      }
      case "archive_item": {
        if (!update.item_id) return { success: false, error: "No item_id for archive" };
        const parsed = parseStagedPatch("archive_item", { is_archived: true, archive_reason: proposed.archive_reason || "Manual", archive_note: proposed.archive_note || "", archived_date: deps.recorder.now().toISOString().slice(0, 10) });
        if (!parsed.ok) return { success: false, error: parsed.error };
        if (opts.dry) return { success: true, itemId: update.item_id };
        const err = await writePatch(sb, update.item_id, "archive_item", parsed.value);
        return err ? { success: false, error: err } : { success: true, itemId: update.item_id };
      }
      default:
        return { success: false, error: `Unknown update type: ${update.update_type}` };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stamp a staged row's disposition (transit resolved). Returns the failure instead of dropping it: a failed stamp leaves the row pending. */
export async function stampDisposition(sb: Db, id: string, patch: Record<string, unknown>): Promise<{ error: string | null }> {
  const { error } = await sb.from("staged_updates").update(patch).eq("id", id);
  return { error: error ? error.message : null };
}

/** Stage a candidate (transit-only, pending). capturedText is a same-invocation carrier and is stripped here; record-only stamps item_grade="record". */
export async function stageCandidate(sb: Db, candidate: Record<string, unknown>, opts: { recordOnly?: boolean; reason?: string } = {}): Promise<{ id: string | null; row: Record<string, unknown> | null; error: string | null }> {
  const { capturedText: _carrier, ...fields } = candidate;
  void _carrier;
  const seed = opts.recordOnly ? { ...fields, item_grade: "record" } : fields;
  const { data, error } = await sb.from("staged_updates").insert({ update_type: "new_item", proposed_changes: seed, reason: opts.reason ?? "manual-intake-run cycle (no-human-finish-of-intake)", source_url: typeof fields.source_url === "string" ? fields.source_url : "", status: "pending", confidence: "MEDIUM" }).select("*").single();
  return error || !data ? { id: null, row: null, error: error?.message ?? "staged insert returned no row" } : { id: String((data as { id: unknown }).id), row: data as Record<string, unknown>, error: null };
}
