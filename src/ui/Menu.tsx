"use client";

// Ported from old_repo/src/components/ui/RowTable.tsx (lines 250-371)
import { useEffect, useRef, useState, type ReactNode } from "react";

import { wrapIndex } from "./focus";

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** Drawn and focusable but not selectable: the label says why (aria-disabled, so arrow keys still reach it and a screen reader reads it). */
  disabled?: boolean;
}

/**
 * The one overflow menu: a 44 px trigger, role menu and menuitem, outside click and Esc close (Esc returns focus to the trigger),
 * Arrow keys rove. A caller needing a custom row passes `extra`.
 */
export function Menu({ label, items, extra }: { label: string; items: MenuItem[]; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      const delta = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!delta || nodes.length === 0) return;
      e.preventDefault();
      nodes[wrapIndex(nodes.length, nodes.indexOf(document.activeElement as HTMLElement), delta)]?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={root} className="cl-menu">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        className="cl-menu-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span aria-hidden="true" className="cl-menu-sep" />
        <span aria-hidden="true" className="cl-menu-dots">
          {"⋯"}
        </span>
      </button>
      {open && (
        <span role="menu" className="cl-menu-pop">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className="cl-menu-item"
              aria-disabled={it.disabled || undefined}
              onClick={() => {
                if (it.disabled) return;
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
          {extra}
        </span>
      )}
    </span>
  );
}
