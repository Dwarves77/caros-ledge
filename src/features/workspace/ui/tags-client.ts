// Ported from old_repo/src/lib/tags/client.ts (lines 31-122)
import { requestJson } from "@/core/http/request-json";

import type { TagApplication } from "../attribution-text";

export interface WorkspaceTag {
  id: string;
  orgId: string;
  name: string;
  /** Number of items the tag is applied to, workspace-wide. */
  itemCount: number;
  createdAt: string;
}

export type ItemTags = { ok: true; tags: WorkspaceTag[]; appliedTagIds: string[]; applications: TagApplication[]; namesUnavailable: boolean } | { ok: false; error: string };

/**
 * The workspace-tags calls. Every one answers with the reason it failed (B-0215: an apply or remove that returned false, and a create that returned
 * null, were ignored), so the popover and the tag row say what happened. A failed list read is an error, never an empty tag list.
 */
export async function fetchItemTags(itemId: string): Promise<ItemTags> {
  const r = await requestJson<{ tags?: WorkspaceTag[]; appliedTagIds?: string[]; applications?: TagApplication[]; namesUnavailable?: boolean }>(`/api/workspace/tags?itemId=${encodeURIComponent(itemId)}`);
  if (!r.ok || !r.data) return { ok: false, error: r.error ?? "Tags could not be loaded." };
  return { ok: true, tags: r.data.tags ?? [], appliedTagIds: r.data.appliedTagIds ?? [], applications: r.data.applications ?? [], namesUnavailable: r.data.namesUnavailable === true };
}

export async function createTag(name: string): Promise<{ tag: WorkspaceTag; error: null } | { tag: null; error: string }> {
  const r = await requestJson<{ tag?: WorkspaceTag }>("/api/workspace/tags", { method: "POST", body: { name } });
  return r.ok && r.data?.tag ? { tag: r.data.tag, error: null } : { tag: null, error: r.error ?? "The tag could not be created." };
}

/** Apply or remove one tag on one item: null when it landed, else why not. */
export async function setTagApplied(tagId: string, itemId: string, applied: boolean): Promise<string | null> {
  const r = await requestJson(`/api/workspace/tags/${encodeURIComponent(tagId)}/items`, { method: applied ? "PUT" : "DELETE", body: { itemId } });
  return r.error;
}
