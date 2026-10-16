// Ported from old_repo/src/components/ui/Skeleton.tsx (lines 14-122)
// Ported from old_repo/src/components/ui/skeleton-page.tsx (lines 1-15)
import type { CSSProperties, ReactNode } from "react";

const box = (h: number | string, w: number | string = "100%"): CSSProperties => ({ height: h, width: w });

/** A page-frame skeleton box (loading.tsx files). */
export const skeletonBox = (h: number, w: string | number = "100%"): CSSProperties => ({ ...box(h, w), borderRadius: 6, background: "var(--tag)" });

/** The route-level skeleton frame: the standard page width and padding, no animation (reduced-motion safe). */
export const SkeletonPage = ({ children }: { children: ReactNode }) => <div className="cl-skel-page">{children}</div>;

/** One list row in its final geometry: the same grid as ListRow, so nothing shifts when data lands. */
export function SkeletonListRow() {
  return (
    <div aria-hidden="true" className="cl-skel-row">
      <span className="cl-skel cl-skel-spine" />
      <span className="cl-skel" style={box(16, 40)} />
      <span className="cl-skel" style={box(14, "70%")} />
      <span className="cl-skel" style={box(9, 60)} />
      <span className="cl-skel" style={box(12, 52)} />
      <span className="cl-skel cl-skel-hide-phone" style={box(1, 76)} />
      <span className="cl-skel" style={box(20, 24)} />
      <span className="cl-skel" style={box(20, 20)} />
    </div>
  );
}

export const SkeletonBandTile = () => (
  <div aria-hidden="true" className="cl-skel-tile">
    <span className="cl-skel" style={box(10, 60)} />
    <span className="cl-skel" style={box(34, 44)} />
    <span className="cl-skel cl-skel-tile-rule" />
  </div>
);

export const SkeletonStatBlock = () => (
  <div aria-hidden="true" className="cl-skel-stat">
    <span className="cl-skel" style={box(10, 70)} />
    <span className="cl-skel" style={box(26, 40)} />
  </div>
);

export const SkeletonRailDateRow = () => (
  <div aria-hidden="true" className="cl-skel-date">
    <span className="cl-skel cl-skel-date-spine" />
    <span className="cl-skel" style={box(12, 44)} />
    <span className="cl-skel" style={box(12, "80%")} />
  </div>
);
