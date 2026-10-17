// Ported from old_repo/src/app/market/loading.tsx (lines 1-21)
import { SkeletonBandTile, SkeletonListRow, SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div style={{ ...skeletonBox(34, "50%"), marginBottom: 10 }} />
      <div style={{ ...skeletonBox(13, "60%"), marginBottom: 20 }} />
      <div className="cl-band-tiles" style={{ marginBottom: 20 }}>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBandTile key={i} />
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <SkeletonListRow key={i} />
      ))}
    </SkeletonPage>
  );
}
