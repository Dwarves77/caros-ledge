"use client";

// Ported from old_repo/src/lib/coverage/client.ts (lines 31-48)
// A named gap with its one action: "Request coverage" records a coverage request for this page (POST /api/dashboard/coverage/request) and says what happened, in place. The failure keeps the button, so the reader can try again.
import { useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { CoverageState } from "@/ui";
import type { CoverageRequestPhase } from "@/ui/CoverageState";

export function CoverageGap({ subject, reason, requestRef }: { subject: string; reason: string; requestRef: string }) {
  const [phase, setPhase] = useState<CoverageRequestPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    setPhase("sending");
    setError(null);
    const r = await requestJson<{ already?: boolean }>("/api/dashboard/coverage/request", { method: "POST", body: { subjectRef: requestRef, label: subject } });
    if (r.ok) setPhase(r.data?.already === true ? "already" : "done");
    else {
      setPhase("failed");
      setError(r.error);
    }
  };
  return <CoverageState state="not_covered" variant="inline" subject={subject} reason={reason} requestRef={requestRef} onRequest={request} requestPhase={phase} requestError={error} />;
}
