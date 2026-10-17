"use client";

// Ported from old_repo/src/components/regulations/PriorityDropdown.tsx (lines 51-471)
// The per-item actions menu on the kit's one Menu (44 px trigger and items, Esc returns focus, arrow keys rove): retag the priority, dismiss, archive (detail only) and the watch control on top.
// A viewer role does not write shared workspace tables (SEC-3b), so a viewer sees the menu only for what is not a write.
import { useState, type ReactNode } from "react";

import { BAND_ORDER } from "@/core/lists";
import { useWorkspaceStore } from "@/core/workspace/store";
import { Menu } from "@/ui";
import { useItemStateStore } from "@/features/workspace/state";
import { ArchiveDialog } from "@/features/workspace/ui/ArchiveDialog";

type Priority = "CRITICAL" | "HIGH" | "MODERATE" | "LOW";

export function PriorityMenu({ itemId, title, priority, label = "Regulation actions", archivable = false, top }: { itemId: string; title: string; priority: string; label?: string; archivable?: boolean; top?: ReactNode }) {
  const updatePriority = useItemStateStore((s) => s.updatePriority);
  const dismiss = useItemStateStore((s) => s.dismissResource);
  const override = useItemStateStore((s) => s.overrides.get(itemId));
  const isViewer = useWorkspaceStore((s) => s.userRole) === "viewer";
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (isViewer && !top && !archivable) return null;
  const current = override?.priorityOverride ?? priority;
  const dismissed = !!override?.dismissedAt;
  const say = (p: Promise<string | null>) => void p.then(setError);
  const items = isViewer
    ? []
    : [
        ...BAND_ORDER.map((b) => ({ key: b.priority, label: `Mark ${b.label}${!dismissed && current === b.priority ? " (current)" : ""}`, onSelect: () => say(updatePriority(itemId, b.priority as Priority)) })),
        { key: "dismiss", label: "Dismiss this regulation", onSelect: () => say(dismiss(itemId)) },
        ...(archivable ? [{ key: "archive", label: "Archive…", onSelect: () => setArchiveOpen(true) }] : []),
      ];
  return (
    <>
      <Menu label={label} items={items} extra={top} />
      {error && (
        <span role="alert" className="cl-detail-link-note">
          {error}
        </span>
      )}
      {archiveOpen && <ArchiveDialog itemId={itemId} title={title} onClose={() => setArchiveOpen(false)} />}
    </>
  );
}
