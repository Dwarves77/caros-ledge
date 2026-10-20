"use client";

// Ported from old_repo/src/lib/coverage/client.ts (lines 1-85)
import { useState } from "react";

import { coverageHref } from "@/core/coverage";
import { requestJson } from "@/core/http/request-json";
import { CoverageState, type CoverageStateProps } from "@/ui/CoverageState";

export interface CoverageCallResult {
  ok: boolean;
  error?: string;
  already?: boolean;
}

/** "Request coverage": one coverage_gap flag for the page path the gap is on. */
async function requestCoverageRequest(input: { subjectRef: string; label: string }): Promise<CoverageCallResult> {
  const r = await requestJson<{ already?: boolean }>("/api/dashboard/coverage/request", { method: "POST", body: input });
  return r.ok ? { ok: true, already: r.data?.already === true } : { ok: false, error: r.error ?? "Could not record that. Try again." };
}

/** Download the CSV for the current axes as a file (a Blob and a clicked object-URL anchor, revoked after). */
export async function downloadCoverageCsv(query: { mode?: string; dataClass?: string; geography?: string }): Promise<CoverageCallResult> {
  if (typeof window === "undefined") return { ok: false, error: "Export runs in the browser." };
  try {
    const qs = coverageHref(query, "").replace(/^\?/, "");
    const res = await fetch(`/api/dashboard/coverage/matrix?format=csv${qs ? `&${qs}` : ""}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return { ok: false, error: res.status === 401 ? "Sign in again to continue." : "The export could not be made. Try again." };
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "coverage.csv";
    const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true };
  } catch {
    return { ok: false, error: "The network request failed. Check your connection and try again." };
  }
}

/** A coverage state whose Request coverage control is wired: the kit never fetches, so this island owns the call and passes the phase down. */
export function RequestableCoverageState(props: Omit<CoverageStateProps, "onRequest" | "requestPhase" | "requestError"> & { requestRef: string }) {
  const [phase, setPhase] = useState<NonNullable<CoverageStateProps["requestPhase"]>>("idle");
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    setPhase("sending");
    setError(null);
    const r = await requestCoverageRequest({ subjectRef: props.requestRef, label: props.subject.slice(0, 120) });
    setPhase(r.ok ? (r.already ? "already" : "done") : "failed");
    setError(r.ok ? null : (r.error ?? null));
  };
  return <CoverageState {...props} onRequest={request} requestPhase={phase} requestError={error} />;
}
