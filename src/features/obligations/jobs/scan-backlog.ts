// New file (scripts/ci/new-files/impact-1.txt): the connect stage's reading of the backlog. For every verified item that has not been read at the current extractor and derivation versions (or whose brief was regenerated after the last read), oldest first, bounded
// per turn: extract the forward events from its claims, sections and captures, derive the register and the obligation objects, and record that the item was read (item_obligation_scan). The ops job derive-obligations stays an operator replay;
// this is the primary path (rule 17: a stage that mints or reads never leaves its downstream to a separate job). Dry plans the same counts and writes nothing.
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import type { RunResult } from "@/core/sources/run-result";
import { currentObligationObjects } from "@/core/workspace";

import { syncComplianceDeadline } from "../derive/compliance-deadline";
import { deriveObligationObjects, OBJECT_DERIVATION_VERSION } from "../derive/derive-objects";
import { DERIVATION_VERSION, deriveRegister } from "../derive/derive-register";
import { EXTRACTOR_VERSION } from "../extract/extract-forward-events";
import { readAndExtractForwardEvents } from "../extract/verbatim-in-source";
import { insertForwardEvents } from "../extract/write-forward-events";

/** Items per derivation read: a capture is a whole document, and a PostgREST read returns at most 1,000 rows. */
const BATCH = 10;
const DERIVATION = `${DERIVATION_VERSION}+${OBJECT_DERIVATION_VERSION}`;

interface ItemRow {
  id: string;
  last_regenerated_at: string | null;
}
interface ScanRow {
  item_id: string;
  scanned_at: string;
  extractor_version: string;
  derivation_version: string;
}

/** The items that need reading, oldest brief first (a brief with no regeneration date first, then by id): never read, read at another version, or regenerated after the last read. Pure. */
function staleItems(items: readonly ItemRow[], scans: readonly ScanRow[]): string[] {
  const read = new Map(scans.map((s) => [s.item_id, s]));
  const stale = items.filter((i) => {
    const s = read.get(i.id);
    return !s || s.extractor_version !== EXTRACTOR_VERSION || s.derivation_version !== DERIVATION || (i.last_regenerated_at !== null && i.last_regenerated_at > s.scanned_at);
  });
  return stale.sort((a, b) => (a.last_regenerated_at ?? "").localeCompare(b.last_regenerated_at ?? "") || a.id.localeCompare(b.id)).map((i) => i.id);
}

/** Every verified live item still to be read, in reading order. A failed read throws: an unreadable backlog is never an empty one. */
async function readStale(sb: Db): Promise<string[]> {
  const items = await fetchAllRows<ItemRow>((from, to) => sb.from("intelligence_items").select("id, last_regenerated_at").eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  const scans = await fetchAllRows<ScanRow>((from, to) => sb.from("item_obligation_scan").select("item_id, scanned_at, extractor_version, derivation_version").order("item_id", { ascending: true }).range(from, to), { cap: 100_000 });
  return staleItems(items, scans);
}

const group = (counts: Record<string, number>, reasons: readonly { reason: string }[]): void => {
  for (const r of reasons) {
    const key = `refused_${r.reason.split(":")[0]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
};
const tally = (rows: readonly Record<string, unknown>[], key: string): Map<string, number> => rows.reduce((m, r) => m.set(String(r[key]), (m.get(String(r[key])) ?? 0) + 1), new Map<string, number>());

/** Read these items: extract, derive, record. The ids of the items read come back in data.ids.scanned_item_ids for the stage behind (propagate scores them). */
async function scanItems(deps: { sb: Db; now: () => Date }, input: { dry: boolean; itemIds: readonly string[] }): Promise<RunResult<{ ids: { scanned_item_ids: string[] } }>> {
  const { sb, now } = deps;
  const today = now().toISOString().slice(0, 10);
  const counts: Record<string, number> = { scanned: 0, extracted: 0, derived: 0, derived_register: 0, derived_objects: 0, refused: 0, skipped_no_duty: 0, deadlines_synced: 0, failed: 0 };
  const bump = (k: string, n: number) => (counts[k] = (counts[k] ?? 0) + n);
  const notes: string[] = [];
  const scanned: string[] = [];
  const ids = [...new Set(input.itemIds)];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const read: string[] = [];
    const planned = new Map<string, number>();
    for (const id of batch) {
      try {
        const r = await readAndExtractForwardEvents(sb, id, now());
        const w = await insertForwardEvents(sb, id, r.events, { claimIds: new Set(r.claims.map((c) => c.claim_id)), sectionIds: new Set(r.sections.map((s) => s.section_id)), captureIds: new Set(r.captures.map((c) => c.capture_id)) }, { dry: input.dry });
        bump("extracted", input.dry ? w.attempted : w.inserted);
        planned.set(id, input.dry ? w.attempted : 0);
        const sync = await syncComplianceDeadline(sb, id, today, { dry: input.dry, pending: input.dry ? r.events.map((e, n) => ({ ...e, id: `pending-${n}` })) : [] });
        if (sync.changed) bump("deadlines_synced", 1);
        read.push(id);
      } catch (e) {
        bump("failed", 1);
        notes.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!read.length) continue;
    try {
      const register = await deriveRegister(sb, { dry: input.dry, itemIds: read });
      const objects = await deriveObligationObjects(sb, { dry: input.dry, itemIds: read });
      if (register.outcome === "failed" || objects.outcome === "failed") throw new Error([...register.notes, ...objects.notes].join("; ") || "derivation failed");
      notes.push(...register.notes.filter((n) => !n.startsWith("dry:")), ...objects.notes.filter((n) => !n.startsWith("dry:")));
      const toInsert = objects.data?.plan.toInsert ?? [];
      bump("derived_register", input.dry ? (register.counts.to_insert ?? 0) + [...planned.values()].reduce((a, b) => a + b, 0) : (register.counts.inserted ?? 0));
      bump("derived_objects", input.dry ? toInsert.length : (objects.counts.inserted ?? 0));
      bump("refused", objects.counts.refused ?? 0);
      group(counts, objects.data?.plan.refused ?? []);
      // What each item holds after this read (a dry run adds what it plans): the evidence the item was read, and the difference between "no duty stated" and "not read yet".
      const events = tally(await fetchAllByIdChunks<Record<string, unknown>>(read, async (slice) => {
        const { data, error } = await sb.from("item_forward_events").select("intelligence_item_id").in("intelligence_item_id", slice);
        if (error) throw new Error(`item_forward_events read failed: ${error.message}`);
        return data ?? [];
      }, { manyPerId: true }), "intelligence_item_id");
      const held = await fetchAllByIdChunks<{ instrument_item_id: string; obligation_id: string; supersedes: string | null }>(read, async (slice) => {
        const { data, error } = await sb.from("obligation_objects").select("instrument_item_id, obligation_id, supersedes").in("instrument_item_id", slice);
        if (error) throw new Error(`obligation_objects read failed: ${error.message}`);
        return data ?? [];
      }, { manyPerId: true });
      const current = tally(currentObligationObjects<(typeof held)[number]>(held) as unknown as Record<string, unknown>[], "instrument_item_id");
      const added = tally(toInsert.map((p) => p.row), "instrument_item_id");
      const rows = read.map((id) => ({ item_id: id, scanned_at: now().toISOString(), extractor_version: EXTRACTOR_VERSION, derivation_version: DERIVATION, events: (events.get(id) ?? 0) + (planned.get(id) ?? 0), objects: (current.get(id) ?? 0) + (input.dry ? (added.get(id) ?? 0) : 0) }));
      bump("skipped_no_duty", rows.filter((r) => r.events === 0 && r.objects === 0).length);
      if (!input.dry) {
        const { error } = await sb.from("item_obligation_scan").upsert(rows, { onConflict: "item_id" });
        if (error) throw new Error(`item_obligation_scan upsert failed: ${error.message}`);
      }
      bump("scanned", rows.length);
      scanned.push(...read);
    } catch (e) {
      bump("failed", read.length);
      notes.push(`${read.length} item(s) not recorded as read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  counts.derived = (counts.derived_register ?? 0) + (counts.derived_objects ?? 0);
  return { counts, outcome: counts.failed ? (counts.scanned ? "partial" : "failed") : "ok", notes: input.dry ? ["dry: nothing written", ...notes] : notes, data: { ids: { scanned_item_ids: scanned } } };
}

/** The connect stage's call: the slice the stage connected (always read) and the backlog (oldest first, at most `limit` of it). */
export async function scanBacklog(deps: { sb: Db; now: () => Date }, input: { dry: boolean; sliceIds: readonly string[]; limit: number }): Promise<RunResult<{ ids: { scanned_item_ids: string[] } }>> {
  const stale = await readStale(deps.sb);
  const slice = new Set(input.sliceIds);
  const backlog = stale.filter((id) => !slice.has(id));
  const r = await scanItems(deps, { dry: input.dry, itemIds: [...input.sliceIds, ...backlog.slice(0, input.limit)] });
  return { ...r, counts: { ...r.counts, backlog: backlog.length, backlog_left: Math.max(0, backlog.length - input.limit) } };
}
