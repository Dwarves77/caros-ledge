// Ported from old_repo/src/lib/tags/attribution.ts (lines 1-89)
// Ported from old_repo/src/lib/tags/server.ts (lines 6-37)
import type { Db } from "@/core/db/clients";
import { fetchAllByIdChunks } from "@/core/db/query";
import { LookupError } from "@/core/http/errors";

import type { TagApplication } from "../attribution-text";

export type { TagApplication };

export interface TagLinkRow {
  tag_id: string;
  created_by: string | null;
  created_at: string | null;
}
export interface ItemTagLinkRow extends TagLinkRow {
  intelligence_item_id: string;
}

/** A member's display name: full name, else display name, else null. An email is never used, so a tag tooltip cannot leak an address. */
function memberDisplayName(profile: { full_name?: string | null; display_name?: string | null } | null | undefined): string | null {
  return profile?.full_name?.trim() || profile?.display_name?.trim() || null;
}

/** One application per join row, with the resolved names. */
export function buildApplications(rows: TagLinkRow[], nameById: ReadonlyMap<string, string | null>): TagApplication[] {
  return rows.map((row) => ({ tagId: row.tag_id, appliedBy: row.created_by, appliedByName: row.created_by ? (nameById.get(row.created_by) ?? null) : null, appliedAt: row.created_at }));
}

/** Group a list-wide join-row read into item id to that item's applications. */
export function groupApplicationsByItem(rows: ItemTagLinkRow[], nameById: ReadonlyMap<string, string | null>): Record<string, TagApplication[]> {
  const out: Record<string, TagApplication[]> = {};
  for (const row of rows) (out[row.intelligence_item_id] ??= []).push(...buildApplications([row], nameById));
  return out;
}

/** Trim and collapse whitespace; null when empty or over the 60-character CHECK, so the route answers 400 without a round trip. */
export function normalizeTagName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 || trimmed.length > 60 ? null : trimmed;
}

/**
 * Display names for a set of member ids (full name, else display name; never an email), read in URL-safe chunks. A failed read throws
 * LookupError; the tags route turns that into `namesUnavailable` so chips render without names instead of failing the list.
 */
export async function loadAuthorNames(client: Db, authorIds: string[]): Promise<Map<string, string | null>> {
  const rows = await fetchAllByIdChunks(authorIds.filter(Boolean), async (slice) => {
    const { data, error } = await client.from("profiles").select("id, full_name, display_name").in("id", slice);
    if (error) throw new LookupError("profiles (tag authors)", error);
    return (data ?? []) as { id: string; full_name?: string | null; display_name?: string | null }[];
  });
  return new Map(rows.map((p) => [p.id, memberDisplayName(p)]));
}
