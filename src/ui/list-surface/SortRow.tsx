// Ported from old_repo/src/components/list-surface/ListSurfaceSortRow.tsx (lines 22-169)
import type { ReactNode } from "react";

export interface SortOption {
  key: string;
  label: string;
}

/** The count line, an optional link, and the segmented Sort or Window control. On the phone the control scrolls sideways as one unit (base.css). */
export function SortRow({ countLabel, linkLabel, onLink, controlLabel, options, active, onSelect }: { countLabel: ReactNode; linkLabel?: string; onLink?: () => void; controlLabel: string; options: SortOption[]; active: string; onSelect: (key: string) => void }) {
  return (
    <div className="cl-sort-row" data-audit="sort-row">
      <div className="cl-sort-count">
        {countLabel}
        {linkLabel && onLink && (
          <>
            {" · "}
            <button type="button" onClick={onLink} className="cl-sort-link">
              {linkLabel}
            </button>
          </>
        )}
      </div>
      <div className="cl-sort-options" data-guard-strip="true">
        <span className="cl-sort-label">{controlLabel}</span>
        {options.map((o) => (
          <button key={o.key} type="button" aria-pressed={o.key === active} onClick={() => onSelect(o.key)} className={`cl-sort-opt${o.key === active ? " cl-sort-opt--on" : ""}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
