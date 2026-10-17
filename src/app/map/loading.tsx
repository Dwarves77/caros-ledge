// Ported from old_repo/src/app/map/page.tsx (lines 1-94)
import { SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div className="cl-skel-stack">
        <div style={skeletonBox(34, "40%")} />
        <div style={skeletonBox(420)} />
        <div style={skeletonBox(160)} />
      </div>
    </SkeletonPage>
  );
}
