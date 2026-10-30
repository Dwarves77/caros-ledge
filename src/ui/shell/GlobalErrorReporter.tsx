"use client";

// Ported from old_repo/src/components/telemetry/GlobalErrorReporter.tsx (lines 1-114)
import { useEffect } from "react";

import { authHeaders } from "@/core/http/authed-fetch";

const SESSION_CAP = 10;
const MIN_INTERVAL_MS = 3000;
const MESSAGE_MAX = 1000;
const STACK_MAX = 4000;
const COUNT_KEY = "cl-err-report-count";
const LAST_KEY = "cl-err-report-last";

function underLimits(): boolean {
  try {
    return Number(sessionStorage.getItem(COUNT_KEY) || "0") < SESSION_CAP && Math.trunc(performance.timeOrigin + performance.now()) - Number(sessionStorage.getItem(LAST_KEY) || "0") >= MIN_INTERVAL_MS;
  } catch {
    return false;
  }
}
/** True when the report was counted; false when storage is blocked (the report is then not rate-limited by storage). */
function bump(): boolean {
  try {
    sessionStorage.setItem(COUNT_KEY, String(Number(sessionStorage.getItem(COUNT_KEY) || "0") + 1));
    sessionStorage.setItem(LAST_KEY, String(Math.trunc(performance.timeOrigin + performance.now())));
    return true;
  } catch {
    return false;
  }
}

/** Post one client error to /api/telemetry/error (P2-03's ingest): per-session capped, spaced, bounded, signed-in only (a pre-auth page is not captured). */
export async function reportClientError(message: string, stack?: string | null): Promise<boolean> {
  try {
    if (!underLimits()) return false;
    bump();
    const headers = await authHeaders({ "content-type": "application/json" });
    if (!headers) return false;
    await fetch("/api/telemetry/error", {
      method: "POST",
      keepalive: true,
      headers,
      body: JSON.stringify({ message: String(message || "Unknown client error").slice(0, MESSAGE_MAX), stack: stack ? String(stack).slice(0, STACK_MAX) : null, path: window.location.pathname }),
    });
    return true;
  } catch {
    return false; // reporting never throws into the page: it answers whether the report went out
  }
}

/** window.onerror and unhandled rejections, reported; renders nothing. */
export function GlobalErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => void reportClientError(e.message || (e.error instanceof Error ? e.error.message : "window.onerror"), e.error instanceof Error ? e.error.stack : null);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      if (r instanceof Error) return void reportClientError(`Unhandled rejection: ${r.message}`, r.stack);
      let text: string;
      try {
        text = JSON.stringify(r);
      } catch {
        text = String(r);
      }
      void reportClientError(`Unhandled rejection: ${text}`, null);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
