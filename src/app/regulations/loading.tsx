// Ported from old_repo/src/app/regulations/loading.tsx (lines 1-22)
import { SkeletonBandTile, SkeletonListRow, SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div className="cl-skel-stack">
        <div style={skeletonBox(34, "50%")} />
        <div style={skeletonBox(13, "60%")} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBandTile key={i} />
          ))}
        </div>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonListRow key={i} />
        ))}
      </div>
    </SkeletonPage>
  );
}
