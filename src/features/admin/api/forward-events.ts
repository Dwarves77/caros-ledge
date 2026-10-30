// Ported from old_repo/src/app/api/admin/forward-events/route.ts (lines 13-101)
import { EVENT_KINDS, PRECISIONS } from "@/features/obligations/kinds";
import { readUpcoming } from "@/features/obligations/read/upcoming-read";

import { adminRoute, boundedInt, reply } from "./shared";

const pick = <T extends string>(raw: string | null, allowed: readonly T[]): T[] => (raw ?? "").split(",").map((s) => s.trim()).filter((s): s is T => (allowed as readonly string[]).includes(s));
const countBy = <T>(rows: readonly T[], key: (r: T) => string): Record<string, number> => rows.reduce<Record<string, number>>((o, r) => ({ ...o, [key(r)]: (o[key(r)] ?? 0) + 1 }), {});

/** Upcoming forward events from a date, by kind and precision, on verified live items only (the one shared read). A failed read answers an error, never an empty list. */
export const GET = adminRoute("/api/admin/forward-events", async (admin, request) => {
  const q = new URL(request.url).searchParams;
  const kinds = pick(q.get("kind"), EVENT_KINDS);
  const precisions = pick(q.get("precision"), PRECISIONS);
  const limit = boundedInt(q.get("limit"), 100, 500);
  const today = new Date(performance.timeOrigin + performance.now()).toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get("from") ?? "") ? (q.get("from") as string) : today;
  const read = await readUpcoming(admin.service(), { kinds: kinds.length ? kinds : [...EVENT_KINDS], from, limit: precisions.length ? 500 : limit }, today);
  const events = (precisions.length ? read.events.filter((e) => (precisions as string[]).includes(e.date_precision)) : read.events).slice(0, limit);
  return reply(admin, { events, stats: { total: events.length, by_kind: countBy(events, (e) => e.event_kind), by_precision: countBy(events, (e) => e.date_precision) }, params: { from, kind: kinds.length ? kinds : null, precision: precisions.length ? precisions : null, limit }, truncated: read.truncated });
});
