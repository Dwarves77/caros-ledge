// Ported from old_repo/src/lib/notifications/dispatch.ts (lines 1-55)
// Who may receive a notification (INV-242): the one filter every writer of notifications passes its rows through. A recipient whose master switch (notification_preferences.enabled) or whose switch for this kind is off,
// or who muted the group the notification belongs to (community_group_members.muted for the payload's group_id), does not receive it. An invite is never dropped: a group or organisation invitation cannot be disabled.
import { fetchAllByIdChunks } from "@/core/db/query";
import { rowsByIds } from "@/core/db/reads";
import type { Db } from "@/core/db/clients";

import type { NotificationKind } from "./dispatch";

export interface Deliverable {
  userId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
}

interface PrefRow {
  user_id: string;
  enabled: boolean;
  on_mention: boolean;
  on_reply_in_my_threads: boolean;
}
/** The per-kind switches notification_preferences holds; a kind with no switch (moderation, archive, assignment) answers to the master switch alone. */
const KIND_SWITCH: Partial<Record<NotificationKind, "on_mention" | "on_reply_in_my_threads">> = { mention: "on_mention", reply: "on_reply_in_my_threads" };
const PREF_COLUMNS = "user_id, enabled, on_mention, on_reply_in_my_threads";

const groupOf = (payload: Record<string, unknown>): string | null => (typeof payload.group_id === "string" && payload.group_id ? payload.group_id : null);

/**
 * The rows that may be delivered, in their order. The reads run on `client` (the service client: another user's rows). A failed preference or mute read THROWS, so a notification is never sent past a setting that could not be
 * checked: the caller (queueNotifications, dispatchNotification) turns the throw into its returned failure message and keeps the write the notification belongs to.
 */
export async function allowedRecipients<T extends Deliverable>(client: Db, rows: T[]): Promise<T[]> {
  const checked = rows.filter((r) => r.kind !== "invite");
  if (checked.length === 0) return rows;
  const users = [...new Set(checked.map((r) => r.userId))];
  const prefs = new Map((await rowsByIds<PrefRow>(client, "notification_preferences", PREF_COLUMNS, users, "user_id", "user_id")).map((p) => [p.user_id, p]));
  const groups = [...new Set(checked.map((r) => groupOf(r.payload)).filter((g): g is string => !!g))];
  const muted = new Set<string>();
  if (groups.length > 0) {
    const found = await fetchAllByIdChunks(
      users,
      async (slice) => {
        const { data, error } = await client.from("community_group_members").select("group_id, user_id").eq("muted", true).in("user_id", slice).in("group_id", groups);
        if (error) throw new Error(`group mute read failed: ${error.message}`);
        return (data ?? []) as Array<{ group_id: string; user_id: string }>;
      },
      { manyPerId: true },
    );
    for (const m of found) muted.add(`${m.user_id}:${m.group_id}`);
  }
  return rows.filter((r) => {
    if (r.kind === "invite") return true;
    const pref = prefs.get(r.userId);
    const sw = KIND_SWITCH[r.kind];
    const group = groupOf(r.payload);
    return !(pref?.enabled === false || (sw ? pref?.[sw] === false : false) || (group !== null && muted.has(`${r.userId}:${group}`)));
  });
}
