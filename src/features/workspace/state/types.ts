// Ported from old_repo/src/stores/resourceStore.ts (lines 80-120)

/**
 * Per-item overrides that belong to the current workspace. Platform data is never mutated: overrides are layered on top
 * (migration 111 dismissals, migration 234 ownership). `ownerName` is resolved server-side from the org roster; null when unassigned
 * or when the assignee has left the org, which the merge layer renders as unassigned.
 */
export interface WorkspaceOverride {
  itemId: string;
  priorityOverride: string | null;
  isArchived: boolean;
  archiveReason: string | null;
  archiveNote: string | null;
  /** The stored archived_at of a team archive: the merge layer shows this date, never the render date. */
  archivedAt?: string | null;
  dismissedAt?: string | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
}

/**
 * The per-USER layer (migration 235), above the workspace override: platform, then org override, then personal. A personal archive hides
 * the item for this user only and is ungated by design (no role, no reason, no fan-out): it is not a team action.
 */
export interface PersonalItemState {
  itemId: string;
  isArchived: boolean;
  archiveNote: string | null;
  archivedAt: string | null;
}
