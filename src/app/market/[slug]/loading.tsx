// Ported from old_repo/src/app/market/[slug]/loading.tsx (lines 1-20)
import { SkeletonPage, skeletonBox } from "@/ui";

export default function Loading() {
  return (
    <SkeletonPage>
      <div style={{ ...skeletonBox(11, 160), marginBottom: "var(--sp-14)" }} />
      <div style={{ ...skeletonBox(34, "70%"), marginBottom: "var(--sp-10)" }} />
      <div style={{ ...skeletonBox(13, "40%"), marginBottom: "var(--sp-24)" }} />
      <div style={{ ...skeletonBox(140), marginBottom: "var(--sp-20)" }} />
      <div style={{ ...skeletonBox(36, "50%"), marginBottom: "var(--sp-18)" }} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ ...skeletonBox(64), marginBottom: "var(--sp-12)" }} />
      ))}
    </SkeletonPage>
  );
}
