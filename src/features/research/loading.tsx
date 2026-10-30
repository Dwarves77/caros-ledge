// Ported from old_repo/src/app/research/loading.tsx (lines 1-21)
// Ported from old_repo/src/app/operations/loading.tsx (lines 1-23)
// The list skeleton of Research and Operations in the final geometry of the page (four band tiles, then rows), so nothing shifts when data lands; a matrix list also draws the matrix card's block.
import { SectionCard, SkeletonBandTile, SkeletonListRow, SkeletonPage, skeletonBox } from "@/ui";

export function ListLoading({ matrix = false }: { matrix?: boolean }) {
  return (
    <SkeletonPage>
      <div className="cl-skel-stack">
        <div style={skeletonBox(34, "40%")} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--sp-12)" }}>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBandTile key={i} />
          ))}
        </div>
        {matrix && <div style={skeletonBox(420)} />}
        <SectionCard>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonListRow key={i} />
          ))}
        </SectionCard>
      </div>
    </SkeletonPage>
  );
}
export default function ResearchLoading() {
  return <ListLoading />;
}
