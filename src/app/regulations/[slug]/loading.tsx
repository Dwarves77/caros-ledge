// Ported from old_repo/src/app/regulations/[slug]/loading.tsx (lines 1-21)
import { SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div className="cl-skel-stack">
        <div style={skeletonBox(11, 160)} />
        <div style={skeletonBox(34, "70%")} />
        <div style={skeletonBox(13, "40%")} />
        <div style={skeletonBox(140)} />
        <div style={skeletonBox(36, "50%")} />
        {[0, 1, 2].map((i) => (
          <div key={i} style={skeletonBox(64)} />
        ))}
      </div>
    </SkeletonPage>
  );
}
