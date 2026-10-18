"use client";

// New in P2-16: the failure note with Retry that a server-read rail draws (a server component cannot hold the click, so the note is this small client part: Retry asks the server again with router.refresh()).
// No old counterpart: the old rails drew a wrong sentence instead.
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { StateNote } from "@/ui";

export function RailRetry({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
      {children}
    </StateNote>
  );
}
