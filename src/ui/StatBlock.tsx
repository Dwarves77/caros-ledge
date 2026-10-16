// Ported from old_repo/src/components/ui/StatBlock.tsx (lines 30-185)
import type { ReactNode } from "react";

interface StatBlockProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  /** A value still loading draws a skeleton box, never 0. */
  loading?: boolean;
  layout?: "stack" | "row";
  tone?: "default" | "critical";
  size?: "default" | "tile";
}

/** Label, Anton numeral, note: a stack, a row, or a compact tile. */
export function StatBlock({ label, value, note, loading, layout = "stack", tone = "default", size = "default" }: StatBlockProps) {
  const critical = tone === "critical" ? " cl-stat-numeral--critical" : "";
  const kind = size === "tile" ? "tile" : layout;
  const numeral = loading ? (
    <span aria-hidden="true" className={`cl-stat-skel cl-stat-skel--${kind}`} />
  ) : (
    <span data-guard-display="stat-block-numeral" className={`cl-stat-numeral cl-stat-numeral--${kind}${critical}`}>
      {value}
    </span>
  );
  const noteNode = note != null && <span className={`cl-stat-note cl-stat-note--${kind}`}>{note}</span>;
  if (size === "tile") {
    return (
      <div data-part="stat-block">
        <div data-guard-container="stat-tile-row" className="cl-stat-tile-row">
          <span className="cl-stat-label cl-stat-label--tile">{label}</span>
          {numeral}
        </div>
        {noteNode}
      </div>
    );
  }
  if (layout === "row") {
    return (
      <div data-part="stat-block" className="cl-stat-row">
        <span className="cl-stat-row-text">
          <span className="cl-stat-label cl-stat-label--row">{label}</span>
          {noteNode}
        </span>
        <span className="cl-stat-row-num">{numeral}</span>
      </div>
    );
  }
  return (
    <div data-part="stat-block">
      <span className="cl-stat-label">{label}</span>
      <div className="cl-stat-stack-num">{numeral}</div>
      {noteNode}
    </div>
  );
}
