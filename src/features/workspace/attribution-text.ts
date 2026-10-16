// Ported from old_repo/src/lib/tags/attribution.ts (lines 1-9)
// Ported from old_repo/src/lib/tags/attribution.ts (lines 68-89)
export interface TagApplication {
  tagId: string;
  /** The applying member's user id; null when that account no longer exists (created_by is ON DELETE SET NULL, migration 313). */
  appliedBy: string | null;
  /** The applying member's display name; null when there is no author or no name on the profile. */
  appliedByName: string | null;
  /** When the tag was applied (item_workspace_tags.created_at). */
  appliedAt: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Sep 2026" in UTC, so the same instant reads the same on the server, in the browser and in a test; null when missing or unparseable. */
export function formatAppliedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "applied by Ada Lovelace on 3 Sep 2026". A removed account reads "a former member"; a member with no name reads "a workspace member". Pure, so the browser and the route share it. */
export function attributionText(application: TagApplication | null | undefined): string | null {
  if (!application) return null;
  const who = application.appliedByName ?? (application.appliedBy ? "a workspace member" : "a former member");
  const when = formatAppliedDate(application.appliedAt);
  return when ? `applied by ${who} on ${when}` : `applied by ${who}`;
}
