// Ported from old_repo/src/components/ui/RowTable.tsx (lines 31-249)
import type { CSSProperties, ReactNode } from "react";

export interface RowTableColumn {
  label: string;
  width: string;
}
export interface RowTableRowSpec {
  key: string;
  cells: ReactNode[];
  id?: string;
  onActivate?: () => void;
  activateLabel?: string;
  below?: ReactNode;
}
interface RowTableProps {
  columns: RowTableColumn[];
  rows: RowTableRowSpec[];
  metrics?: { paddingLeft?: number; rowMinHeight?: number; ruleAfterLastRow?: boolean };
}

const grid = (columns: RowTableColumn[], paddingLeft: number): CSSProperties => ({ gridTemplateColumns: columns.map((c) => c.width).join(" "), padding: `0 12px 0 ${paddingLeft}px` });

/** The admin and community table anatomy: header strip, activatable rows, a below-row slot. Scrolls sideways on the phone (base.css). */
export function RowTable({ columns, rows, metrics }: RowTableProps) {
  const paddingLeft = metrics?.paddingLeft ?? 16;
  const rowMinHeight = metrics?.rowMinHeight ?? 48;
  return (
    <div className="cl-rowtable" data-guard-strip="true">
      <div className="cl-rowtable-grid cl-rowtable-head" style={grid(columns, paddingLeft)}>
        {columns.map((c, i) => (
          <span key={`${c.label}-${i}`} className="cl-rowtable-cell">
            {c.label}
          </span>
        ))}
      </div>
      {rows.map((r, i) => {
        const rule = i === rows.length - 1 && !metrics?.ruleAfterLastRow ? undefined : "1px solid var(--line-3)";
        return (
          <div key={r.key}>
            <div
              id={r.id}
              role={r.onActivate ? "button" : undefined}
              tabIndex={r.onActivate ? 0 : undefined}
              aria-label={r.onActivate ? r.activateLabel : undefined}
              onClick={r.onActivate}
              onKeyDown={
                r.onActivate
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        r.onActivate?.();
                      }
                    }
                  : undefined
              }
              className="cl-rowtable-grid cl-rowtable-row"
              style={{ ...grid(columns, paddingLeft), minHeight: rowMinHeight, borderBottom: r.below ? undefined : rule, cursor: r.onActivate ? "pointer" : undefined }}
            >
              {r.cells.map((cell, ci) => (
                <span key={ci} className="cl-rowtable-cell">
                  {cell}
                </span>
              ))}
            </div>
            {r.below && <div style={{ padding: `0 12px 12px ${paddingLeft}px`, borderBottom: rule }}>{r.below}</div>}
          </div>
        );
      })}
    </div>
  );
}

export const RowTableAction = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
  <button type="button" onClick={onClick} disabled={disabled} className="cl-btn cl-btn--secondary cl-btn--md cl-rowtable-action">
    {label}
  </button>
);
