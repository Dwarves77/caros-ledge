// Ported from old_repo/src/lib/notifications/dispatch.ts (lines 41-55)
import { serviceClient, type Db } from "@/core/db/clients";

import type { NotificationKind } from "./dispatch";

export interface OutboxInput {
  userId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
}

/**
 * Queue notifications for the drain (notification_outbox, migration 0025, IMP-025): ONE insert for every recipient, so the batch lands or fails whole,
 * and a failed send later is retried with its attempts and last_error recorded instead of being counted and lost. Returns null when queued or the
 * failure message; it never throws, so the caller reports the failure and keeps the write it belongs to.
 */
export async function queueNotifications(rows: OutboxInput[], client?: Db): Promise<string | null> {
  if (rows.length === 0) return null;
  try {
    const { error } = await (client ?? serviceClient()).from("notification_outbox").insert(rows.map((r) => ({ user_id: r.userId, kind: r.kind, payload: r.payload })));
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : "unknown error";
  }
}
