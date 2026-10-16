"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 721-730)
import { EmptyState, FormCard } from "@/ui";

export function ActivityTab() {
  return (
    <FormCard title="Activity">
      <EmptyState>Your activity is not recorded yet. When it is, the briefs you read, the searches you save and your community posts will be listed here.</EmptyState>
    </FormCard>
  );
}
