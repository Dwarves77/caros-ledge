// Ported from old_repo/src/app/community/browse/page.tsx (lines 59-239)
import { BrowsePage } from "@/features/community/pages/Browse";

export const metadata = { title: "Browse groups" };

export default async function Page({ searchParams }: { searchParams: Promise<{ region?: string }> }) {
  return <BrowsePage region={(await searchParams).region} />;
}
