"use client";

// Ported from old_repo/src/app/error.tsx (lines 1-52)
import { useEffect } from "react";

import { ErrorState } from "@/ui/Banners";
import { reportClientError } from "@/ui/shell/GlobalErrorReporter";

/** The route-neutral error boundary: plain copy, the digest as a reference, Retry. It never echoes the raw message and never names a vendor or blames the database. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void reportClientError(`${error.message}${error.digest ? ` [digest:${error.digest}]` : ""}`, error.stack);
  }, [error]);
  return (
    <div className="cl-page-pad">
      <ErrorState title="This page could not load" message="Something went wrong on our side. Try again; nothing in your account has changed." reference={error.digest} onRetry={reset} />
    </div>
  );
}
