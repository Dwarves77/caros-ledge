// Ported from old_repo/src/lib/propagation/methods/superseded-notices.ts (lines 1-117)
// Recalculation notices: the old and new derived-value pairs for watched entities since a date, with the event that triggered each. Every read
// error throws (the old reader returned [] on any failure, so an outage looked like "nothing was recalculated"); the caller answers 503.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";

export interface SupersededNotice {
  entityId: string | null;
  methodId: string;
  oldValueId: string;
  oldMethodVersion: string;
  oldValue: number | null;
  oldValueLow: number | null;
  oldValueHigh: number | null;
  newValueId: string;
  newMethodVersion: string;
  newValue: number | null;
  newValueLow: number | null;
  newValueHigh: number | null;
  unit: string | null;
  currency: string | null;
  supersededAt: string;
  triggeringEvent: { table: string; pk: string; changeKind: string; occurredAt: string } | null;
}
interface Raw {
  value_id: string;
  entity_id: string | null;
  method_id: string;
  method_version: string;
  value: number | null;
  value_low: number | null;
  value_high: number | null;
  unit: string | null;
  currency: string | null;
  supersedes: string | null;
  computed_at: string;
  invalidated_by_event: number | null;
}
const COLS = "value_id,entity_id,method_id,method_version,value,value_low,value_high,unit,currency,supersedes,computed_at,invalidated_by_event";

export async function fetchSupersededNotices(sb: Db, entityIds: readonly string[], sinceIso: string): Promise<SupersededNotice[]> {
  if (!entityIds.length) return [];
  const news = await fetchAllByIdChunks<Raw>(entityIds, async (slice) => {
    const { data, error } = await sb.from("derived_values").select(COLS).in("entity_id", slice).gte("computed_at", sinceIso);
    if (error) throw new Error(`notices: derived_values read failed: ${error.message}`);
    return (data ?? []) as Raw[];
  }, { manyPerId: true });
  const newRows = news.filter((r) => r.supersedes);
  if (!newRows.length) return [];
  const olds = await fetchAllByIdChunks<Raw>(newRows.map((r) => r.supersedes as string), async (slice) => {
    const { data, error } = await sb.from("derived_values").select(COLS).in("value_id", slice);
    if (error) throw new Error(`notices: superseded derived_values read failed: ${error.message}`);
    return (data ?? []) as Raw[];
  });
  const oldById = new Map(olds.map((r) => [r.value_id, r]));
  const eventIds = [...new Set(olds.map((r) => r.invalidated_by_event).filter((id): id is number => id != null))];
  const events = eventIds.length
    ? await fetchAllByIdChunks<{ event_id: number; table_name: string; row_pk: string; change_kind: string; occurred_at: string }>(eventIds.map(String), async (slice) => {
        const { data, error } = await sb.from("recalculation_events").select("event_id,table_name,row_pk,change_kind,occurred_at").in("event_id", slice);
        if (error) throw new Error(`notices: recalculation_events read failed: ${error.message}`);
        return data ?? [];
      })
    : [];
  const eventById = new Map(events.map((e) => [e.event_id, e]));
  const out: SupersededNotice[] = [];
  for (const n of newRows) {
    const o = oldById.get(n.supersedes as string);
    if (!o) continue;
    const ev = o.invalidated_by_event != null ? eventById.get(o.invalidated_by_event) : undefined;
    out.push({
      entityId: n.entity_id, methodId: n.method_id, oldValueId: o.value_id, oldMethodVersion: o.method_version, oldValue: o.value, oldValueLow: o.value_low, oldValueHigh: o.value_high,
      newValueId: n.value_id, newMethodVersion: n.method_version, newValue: n.value, newValueLow: n.value_low, newValueHigh: n.value_high, unit: n.unit, currency: n.currency, supersededAt: n.computed_at,
      triggeringEvent: ev ? { table: ev.table_name, pk: ev.row_pk, changeKind: ev.change_kind, occurredAt: ev.occurred_at } : null,
    });
  }
  return out;
}
