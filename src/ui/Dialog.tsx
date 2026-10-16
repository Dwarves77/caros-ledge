"use client";

// New in P2-09: the one overlay primitive. Replaces the hand-rolled overlays (sources/SourceTierLegend.tsx 150-262, workspace/ArchiveDialog.tsx, profile/MembersPanel.tsx).
// Ported from old_repo/src/components/Sidebar.tsx (lines 471-525)
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { FOCUSABLE, trapIndex } from "./focus";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** The accessible title; shown in the head unless `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  /** `center` is a modal card; `side` a left drawer; `bottom` a bottom sheet. */
  placement?: "center" | "side" | "bottom";
  children: ReactNode;
  /** An element id inside the dialog to focus first; default is the first focusable. */
  initialFocusId?: string;
}

/**
 * Scrim, Esc, Tab trap, focus move on open and focus return to the opener on close, a 44 px close control and aria-modal.
 * Every overlay in the product is this part; none re-implements the contract.
 */
export function Dialog({ open, onClose, title, hideTitle, placement = "center", children, initialFocusId }: DialogProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    const focusables = () => (node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    const first = (initialFocusId ? document.getElementById(initialFocusId) : null) ?? focusables()[0] ?? node;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && node) {
        const list = focusables();
        const next = trapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (next < 0) return;
        e.preventDefault();
        list[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, initialFocusId]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className={`cl-dialog cl-dialog--${placement}`} data-part="dialog">
      <div className="cl-dialog-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="cl-dialog-panel">
        <div className="cl-dialog-head">
          <h2 id={titleId} className={hideTitle ? "cl-sr-only" : "cl-dialog-title"}>
            {title}
          </h2>
          <button type="button" className="cl-dialog-close" aria-label={`Close ${title}`} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="cl-dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
