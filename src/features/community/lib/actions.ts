// Ported from old_repo/src/components/community/GroupHeader.tsx (lines 94-147)
// Ported from old_repo/src/components/community/ModerationActions.tsx (lines 46-130)
// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 375-402)
// The member actions whose failure must be SAID (the old tree let a failed star, mute or moderation action revert or vanish silently because the toast callback was never passed): each takes the client and the one notify
// function, applies its change optimistically where the screen needs it, and on a refusal puts the change back and shows the server's own sentence. Pure of React, so a test drives each with a failing client.
import type { communityApi, Result } from "./api";

export type Api = typeof communityApi;
export type Notify = (message: string, variant?: "success" | "error") => void;

/** The refusal's sentence, else the fallback. */
export const sentence = (r: Result<unknown>, fallback: string): string => r.error || fallback;

/** Star or mute a group: the change is shown at once, put back on a refusal, and the outcome is toasted either way. */
export async function setGroupPref(api: Pick<Api, "setStarred" | "setMuted">, notify: Notify, kind: "starred" | "muted", groupId: string, next: boolean, apply: (value: boolean) => void): Promise<boolean> {
  apply(next);
  const r = await (kind === "starred" ? api.setStarred(groupId, next) : api.setMuted(groupId, next));
  if (r.ok) {
    notify(kind === "starred" ? (next ? "Group starred" : "Star removed") : next ? "Group muted: you will not be notified about it" : "Group unmuted");
    return true;
  }
  apply(!next);
  notify(sentence(r, kind === "starred" ? "The star could not be changed." : "The mute could not be changed."), "error");
  return false;
}

const DONE: Record<string, string> = { dismiss: "Report dismissed", warn: "Warning sent", remove: "Post removed", mute: "Member muted", ban: "Member banned from the group" };

/** Act on a moderation report; the result and any failure are toasted, and `onDone` runs only when the report closed. */
export async function actOnReport(api: Pick<Api, "act">, notify: Notify, reportId: string, action: "dismiss" | "warn" | "remove" | "mute" | "ban", notes: string, onDone: () => void, days?: 1 | 7 | 30): Promise<boolean> {
  const r = await api.act(reportId, action, notes.trim() || undefined, days);
  if (!r.ok || !r.data) {
    notify(sentence(r, "The action could not be recorded."), "error");
    return false;
  }
  notify(r.data.notified ? DONE[action] ?? "Done" : `${DONE[action] ?? "Done"}. The member could not be notified.`, r.data.notified ? "success" : "error");
  onDone();
  return true;
}

/** Join or leave a room or group: both go through the routes (the old room list wrote its membership row from the browser). */
export async function setMembership(api: Pick<Api, "joinGroup" | "leaveGroup">, notify: Notify, groupId: string, join: boolean): Promise<boolean> {
  const r = await (join ? api.joinGroup(groupId) : api.leaveGroup(groupId));
  if (!r.ok) notify(sentence(r, join ? "You could not join this group." : "You could not leave this group."), "error");
  return r.ok;
}

/** Cite a live system item in a thread: a route under the caller's row policy, not a table write from the browser. */
export async function citeItem(api: Pick<Api, "cite">, notify: Notify, postId: string, itemUuid: string | null): Promise<string[] | null> {
  if (!itemUuid) {
    notify("That item can't be cited yet.", "error");
    return null;
  }
  const r = await api.cite(postId, itemUuid);
  if (!r.ok || !r.data) {
    notify(sentence(r, "The item could not be cited."), "error");
    return null;
  }
  return r.data.cited;
}
