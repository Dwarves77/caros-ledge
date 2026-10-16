// Ported from old_repo/src/lib/tags/attribution.ts (lines 1-89)
// Ported from old_repo/src/lib/tags/server.ts (lines 6-37)
import type { Db } from "@/core/db/clients";
import { fetchAllByIdChunks } from "@/core/db/query";
import { LookupError } from "@/core/http/errors";

export interface TagApplication {
  tagId: string;
  /** The applying member's user id; null when that account no longer exists (created_by is ON DELETE SET NULL, migration 313). */
  appliedBy: string | null;
  /** The applying member's display name; null when there is no author or no name on the profile. */
  appliedByName: string | null;
  /** When the tag was applied (item_workspace_tags.created_at). */
  appliedAt: string | null;
}

export interface TagLinkRow {
  tag_id: string;
  created_by: string | null;
  created_at: string | null;
}
export interface ItemTagLinkRow extends TagLinkRow {
  intelligence_item_id: string;
}

/** A member's display name: full name, else display name, else null. An email is never used, so a tag tooltip cannot leak an address. */
export function memberDisplayName(profile: { full_name?: string | null; display_name?: string | null } | null | undefined): string | null {
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Sep 2026" in UTC, so the same instant reads the same on the server, in the browser and in a test; null when missing or unparseable. */
export function formatAppliedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "applied by Ada Lovelace on 3 Sep 2026". A removed account reads "a former member"; a member with no name reads "a workspace member". */
export function attributionText(application: TagApplication | null | undefined): string | null {
  if (!application) return null;
  const who = application.appliedByName ?? (application.appliedBy ? "a workspace member" : "a former member");
  const when = formatAppliedDate(application.appliedAt);
  return when ? `applied by ${who} on ${when}` : `applied by ${who}`;
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
