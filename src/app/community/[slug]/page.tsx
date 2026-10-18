// Ported from old_repo/src/app/community/[slug]/page.tsx (lines 38-273)
import { GroupPage } from "@/features/community/pages/Group";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <GroupPage slug={(await params).slug} />;
}
