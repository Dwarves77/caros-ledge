"use client";

// Ported from old_repo/src/components/Sidebar.tsx (lines 471-525)
// Ported from old_repo/src/components/list-surface/ListSurfaceShell.tsx (lines 240-317)
import type { ReactNode } from "react";

import { Dialog } from "../Dialog";

/** A side drawer (the nav) or a bottom sheet (the filters) over the one Dialog: scrim, Esc, focus trap and focus return come from it. */
export function Sheet({ open, onClose, title, side = "bottom", hideTitle, children }: { open: boolean; onClose: () => void; title: string; side?: "left" | "bottom"; hideTitle?: boolean; children: ReactNode }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} placement={side === "left" ? "side" : "bottom"} {...(hideTitle ? { hideTitle } : {})}>
      {children}
    </Dialog>
  );
}
