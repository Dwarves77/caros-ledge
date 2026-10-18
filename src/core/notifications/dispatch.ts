// Ported from old_repo/src/lib/notifications/dispatch.ts (lines 8-20)
// Ported from old_repo/src/lib/notifications/dispatch.ts (lines 41-55)
import { serviceClient, type Db } from "@/core/db/clients";

import { allowedRecipients } from "./preferences";

/** A subset of the notifications_kind_check CHECK ('promote' is retired from code: Community is social only, ADR-041). */
export type NotificationKind = "reply" | "invite" | "moderation" | "mention" | "archive" | "assignment";

export interface DispatchArgs {
  userId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
}
/**
 * Insert one notifications row on the shared service client, unless the recipient's preferences or group mute say not to (allowedRecipients; an invite always goes). Returns null on success (a row dropped by a preference
 * is a success: nothing was owed) or the error message; it never throws, so a caller logs the failure without aborting the user's operation.
 */
export async function dispatchNotification(args: DispatchArgs, client?: Db): Promise<string | null> {
  try {
    const db = client ?? serviceClient();
    if ((await allowedRecipients(db, [args])).length === 0) return null;
    const { error } = await db.from("notifications").insert({ user_id: args.userId, kind: args.kind, payload: args.payload });
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : "unknown error";
  }
}
