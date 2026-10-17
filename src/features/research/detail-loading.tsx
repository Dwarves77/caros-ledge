// Ported from old_repo/src/app/research/[slug]/loading.tsx (lines 1-15)
// Ported from old_repo/src/app/operations/[slug]/loading.tsx (lines 1-14)
// The detail skeleton of Research and Operations: a masthead block, the section index bar, then two section blocks beside the rail, in the page's final geometry.
import { SkeletonPage, skeletonBox } from "@/ui";

export default function DetailLoading() {
  return (
    <SkeletonPage>
      <div className="cl-skel-stack">
        <div style={skeletonBox(120)} />
        <div style={skeletonBox(44)} />
        <div style={skeletonBox(220)} />
        <div style={skeletonBox(220)} />
      </div>
    </SkeletonPage>
  );
}
