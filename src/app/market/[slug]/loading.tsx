// Ported from old_repo/src/app/market/[slug]/loading.tsx (lines 1-20)
import { SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div style={{ ...skeletonBox(11, 160), marginBottom: 14 }} />
      <div style={{ ...skeletonBox(34, "70%"), marginBottom: 10 }} />
      <div style={{ ...skeletonBox(13, "40%"), marginBottom: 24 }} />
      <div style={{ ...skeletonBox(140), marginBottom: 20 }} />
      <div style={{ ...skeletonBox(36, "50%"), marginBottom: 18 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ ...skeletonBox(64), marginBottom: 12 }} />
      ))}
    </SkeletonPage>
  );
}
