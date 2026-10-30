// Ported from old_repo/src/components/detail/item-collab-client.ts (lines 1-63)
// The call the notes and assignments blocks make: the app's one JSON caller (it never throws, a refusal carries the server's message, the session is the cookie), with the retry wording
// for the two refusals a reader can fix themselves. The routes are P2-02's /api/workspace/items/[id]/{notes,assignments}.
import { requestJson as request, type JsonResult } from "@/core/http/request-json";

export type CollabResult<T> = JsonResult<T>;
export const collabPath = (itemId: string, kind: "notes" | "assignments"): string => `/api/workspace/items/${encodeURIComponent(itemId)}/${kind}`;

/** One collab call. A 429 and a failed save say that what was typed is kept. */
export async function collabRequest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<JsonResult<T>> {
  const r = await request<T>(path, init);
  if (r.ok) return r;
  if (r.status === 429) return { ...r, error: "Too many requests just now. Wait a moment, then retry; what you typed is kept." };
  if (r.status >= 500 || r.status === 0) return { ...r, error: `${r.error ?? "That did not save."} What you typed is kept.` };
  return r;
}

/** The roster's fallback label for a member with no profile name: the first eight characters of the id and three dots. */
export const isIdLabel = (name: string): boolean => name.length === 11 && name.endsWith("...") && [...name.slice(0, 8)].every((c) => "0123456789abcdef".includes(c));
