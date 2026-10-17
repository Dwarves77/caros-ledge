"use client";

// Ported from old_repo/src/components/ui/ErrorState.tsx (lines 12-44)
// A part of the page whose read failed (INV-263): it says which part, and Retry asks the server again. The rest of the page stays.
import { useRouter } from "next/navigation";

import { StateNote } from "@/ui/StateNote";

export function RetryNote({ what }: { what: string }) {
  const router = useRouter();
  return (
    <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
      {what} did not load. Nothing is missing from your data; this is on our side. Try again.
    </StateNote>
  );
}
