"use client";

// Ported from old_repo/src/components/ui/DetailTagRow.tsx (lines 20-90)
import { useCallback, useEffect, useState } from "react";

import { useWorkspaceStore } from "@/core/workspace/store";
import { InlineErrorBanner, WorkspaceTagPill } from "@/ui";

import { attributionText, type TagApplication } from "../attribution-text";

import { TagPopover } from "./TagPopover";
import { fetchItemTags, setTagApplied, type ItemTags, type WorkspaceTag } from "./tags-client";

/**
 * The detail header's tag row: the item's applied workspace tags with who applied each, then the popover anchor. The action row's "+ Tag" is the one
 * trigger (`open` and `onOpenChange` come from it). A viewer reads the pills without the remove control; a failed read or a refused remove says so.
 */
export function DetailTagRow({ itemId, open, onOpenChange }: { itemId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [applied, setApplied] = useState<WorkspaceTag[]>([]);
  const [applications, setApplications] = useState<TagApplication[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const isViewer = useWorkspaceStore((s) => s.userRole) === "viewer";

  const show = useCallback((r: ItemTags) => {
    if (!r.ok) return setProblem(r.error);
    const ids = new Set(r.appliedTagIds);
    setProblem(null);
    setApplied(r.tags.filter((t) => ids.has(t.id)));
    setApplications(r.applications);
    setLoaded(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchItemTags(itemId).then((r) => !cancelled && show(r));
    return () => {
      cancelled = true;
    };
  }, [itemId, show]);

  const titleFor = (tagId: string) => {
    const note = attributionText(applications.find((a) => a.tagId === tagId));
    return note ? { title: note } : {};
  };

  async function remove(tag: WorkspaceTag) {
    const error = await setTagApplied(tag.id, itemId, false);
    if (error) setProblem(error);
    else setApplied((prev) => prev.filter((t) => t.id !== tag.id));
  }

  return (
    <div>
      {loaded && applied.length > 0 ? (
        <div className="cl-filter-group-chips">
          {applied.map((tag) => (
            <WorkspaceTagPill key={tag.id} name={tag.name} {...titleFor(tag.id)} {...(isViewer ? {} : { onRemove: () => void remove(tag) })} />
          ))}
        </div>
      ) : null}
      {problem ? <InlineErrorBanner message={problem} /> : null}
      <TagPopover itemId={itemId} open={open} onOpenChange={onOpenChange} onChange={() => void fetchItemTags(itemId).then(show)} />
    </div>
  );
}
