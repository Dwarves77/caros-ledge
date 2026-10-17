"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { StateNote } from "@/ui";

/** A settings section whose server read failed: the reason, and a Retry that asks the server for the page again (INV-263: a failed read is never an empty list). */
export function FailedBlock({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
      {children}
    </StateNote>
  );
}
