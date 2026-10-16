// Ported from old_repo/src/components/settings/ArchiveViewer.tsx (lines 20-25)
export interface ItemLink {
  title: string;
  href: string;
}

/** One archived item as the archive list shows it. `scope` says who the archive hides it from, because that decides what Restore undoes. */
export interface ArchiveRow extends ItemLink {
  /** The id the item-state writers take (the UI id: legacy id, else uuid). */
  itemId: string;
  scope: "team" | "personal";
  reason: string | null;
  note: string | null;
  archivedAt: string | null;
  replacement: ItemLink | null;
}
