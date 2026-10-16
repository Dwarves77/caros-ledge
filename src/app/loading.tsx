// Ported from old_repo/src/app/loading.tsx (lines 1-57)
import { SkeletonPage, skeletonBox } from "@/ui/Skeleton";

/** The route-neutral loading frame: a head block and three list blocks in the standard page frame, no animation. */
export default function Loading() {
  return (
    <SkeletonPage>
      <div className="cl-skel-stack">
        <div style={skeletonBox(34, "40%")} />
        <div style={skeletonBox(14, "65%")} />
        {[0, 1, 2].map((i) => (
          <div key={i} style={skeletonBox(96)} />
        ))}
      </div>
    </SkeletonPage>
  );
}
