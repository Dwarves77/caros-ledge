"use client";

// Ported from old_repo/src/components/coverage/CoverageExportButton.tsx (lines 1-53)
import { useState } from "react";

import { Button } from "@/ui";

import { downloadCoverageCsv } from "../client";

/** Download the CSV for the axes on screen: one press, "Preparing the file..." the moment it is pressed, then what the file holds. A failure says what went wrong and leaves the control in place to try again. 44 px tall. */
export function ExportButton({ query, label }: { query: { mode?: string; dataClass?: string; geography?: string }; label: string }) {
  const [phase, setPhase] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (phase === "sending") return;
    setPhase("sending");
    setError(null);
    const r = await downloadCoverageCsv(query);
    setPhase(r.ok ? "done" : "idle");
    if (!r.ok) setError(r.error ?? "The export could not be made. Try again.");
  };
  return (
    <div className="cl-coverage-actions">
      <Button variant="primary" disabled={phase === "sending"} onClick={() => void run()}>{phase === "sending" ? "Preparing the file..." : "Download CSV"}</Button>
      {phase === "done" ? <span role="status" className="cl-coverage-feedback">Saved. The file holds {label}, with its version and dates in columns.</span> : null}
      {error ? <span role="alert" className="cl-coverage-feedback cl-coverage-feedback--error">{error}</span> : null}
    </div>
  );
}
