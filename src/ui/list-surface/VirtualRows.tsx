"use client";

// Ported from old_repo/src/components/ledger/VirtualizedRowList.tsx (lines 1-206)
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useScrollContainer } from "../shell/scroll-container";

interface VirtualRowsProps<T> {
  rows: T[];
  rowHeight: number;
  overscan?: number;
  getRowId: (row: T) => string;
  renderRow: (row: T, index: number) => ReactNode;
}

function InBox<T>({ rows, rowHeight, overscan = 8, getRowId, renderRow, box }: VirtualRowsProps<T> & { box: HTMLElement }) {
  const holder = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  // The list's offset inside the scroll box, re-measured when the box or the row count changes (the old hook measured once).
  useLayoutEffect(() => {
    if (holder.current) setMargin(holder.current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop);
  }, [box, rows.length]);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer's functions are used only inside this component
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box, estimateSize: () => rowHeight, overscan, scrollMargin: margin, getItemKey: (i) => getRowId(rows[i] as T) });
  return (
    <div ref={holder} className="cl-virtual" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((vi) => (
        <div key={vi.key} data-index={vi.index} ref={v.measureElement} className="cl-virtual-item" style={{ transform: `translateY(${vi.start - margin}px)` }}>
          {renderRow(rows[vi.index] as T, vi.index)}
        </div>
      ))}
    </div>
  );
}

/** Rows virtualized inside the shell's scroll box (<main>). Outside a shell, or before the box registers, every row is drawn (a short list, a fixture). */
export function VirtualRows<T>(props: VirtualRowsProps<T>) {
  const box = useScrollContainer();
  if (!box) return <div>{props.rows.map((r, i) => <div key={props.getRowId(r)}>{props.renderRow(r, i)}</div>)}</div>;
  return <InBox {...props} box={box} />;
}
