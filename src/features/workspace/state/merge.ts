// Ported from old_repo/src/stores/resourceStore.ts (lines 572-645)
import type { Resource } from "@/core/types";

import type { PersonalItemState, WorkspaceOverride } from "./types";

type Priority = Resource["priority"];

/**
 * Combine platform resources with the workspace overrides: this is what the UI renders, the effective view for this workspace.
 * Layer order is platform, then org override, then personal state. The personal layer is checked FIRST for archive because it is the
 * narrower scope: a user who archived an item for themselves keeps it hidden whatever the workspace did, and restoring it for the team
 * must not un-hide it for them. The date shown for an archive is the STORED archived_at, never the render date.
 */
export function mergeWithOverrides(
  resources: Resource[],
  overrides: Map<string, WorkspaceOverride>,
  personalState?: Map<string, PersonalItemState>,
): { active: Resource[]; archived: Resource[]; dismissed: Resource[] } {
  const active: Resource[] = [];
  const archived: Resource[] = [];
  const dismissed: Resource[] = [];
  for (const r of resources) {
    const override = overrides.get(r.id);
    const personal = personalState?.get(r.id);
    const priority = (override?.priorityOverride as Priority | null | undefined) || r.priority;
    // The org-scoped assignee surfaces through actionOwner; ownerName is null for a departed member, which renders unassigned.
    const owner = override?.ownerName ? { actionOwner: override.ownerName } : {};
    if (personal?.isArchived) {
      archived.push({ ...r, priority, ...owner, isArchived: true, archiveReason: "personal", ...(personal.archiveNote ? { archiveNote: personal.archiveNote } : {}), ...(personal.archivedAt ? { archivedDate: personal.archivedAt.slice(0, 10) } : {}) });
    } else if (override?.isArchived) {
      archived.push({
        ...r,
        priority,
        ...owner,
        isArchived: true,
        ...(override.archiveReason ? { archiveReason: override.archiveReason } : {}),
        ...(override.archiveNote ? { archiveNote: override.archiveNote } : {}),
        ...(override.archivedAt ? { archivedDate: override.archivedAt.slice(0, 10) } : {}),
      });
    } else if (override?.dismissedAt) {
      // Dismissed regulations land in the stash drawer; they do not appear in the active view.
      dismissed.push({ ...r, priority, ...owner });
    } else active.push({ ...r, priority, ...owner });
  }
  return { active, archived, dismissed };
}
