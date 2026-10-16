"use client";

// Ported from old_repo/src/components/ui/ErrorState.tsx (lines 12-44)
import { useRouter } from "next/navigation";

import { ErrorState } from "@/ui";

/** What a page shows when its server read failed: the failure and a Retry that asks the server again. The one failure page of the account, settings and onboarding routes. */
export function PageFailure({ what }: { what: string }) {
  const router = useRouter();
  return <ErrorState title={`${what} did not load`} message="Something went wrong on our side. Try again; nothing you have saved was changed." onRetry={() => router.refresh()} />;
}
