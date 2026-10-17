// Ported from old_repo/src/app/market/series/page.tsx (lines 1-23)
import { SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div style={{ ...skeletonBox(34, "50%"), marginBottom: 10 }} />
      <div style={{ ...skeletonBox(13, "60%"), marginBottom: 20 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ ...skeletonBox(120), marginBottom: 12 }} />
      ))}
    </SkeletonPage>
  );
}
