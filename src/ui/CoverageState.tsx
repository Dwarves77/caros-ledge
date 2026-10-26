// Ported from old_repo/src/components/ui/CoverageState.tsx (lines 31-85)
// Ported from old_repo/src/components/ui/CoverageState.tsx (lines 124-236)
import type { ReactNode } from "react";

import { describeCoverageState } from "@/core/coverage";

import { ABSENCE_DASH } from "./absence-reason";
import { Button } from "./Button";

export type CoverageRequestPhase = "idle" | "sending" | "done" | "already" | "failed";

export interface CoverageStateProps {
  state: string | null | undefined;
  subject: string;
  variant?: "block" | "inline" | "cell";
  reason?: string | null;
  reasonClass?: string | null;
  roadmap?: string | null;
  requestRef?: string | null;
  expectedRefresh?: string | null;
  lastValue?: string | null;
  asOf?: string | null;
  hiddenCount?: number | null;
  noun?: string | null;
  onWiden?: (() => void) | null;
  onRetry?: (() => void) | null;
  retryHref?: string | null;
  statusHref?: string | null;
  fallback?: ReactNode;
  /** The request action: the coverage feature owns the fetch and passes the callback and the phase (the kit never fetches). */
  onRequest?: (() => void) | null;
  requestPhase?: CoverageRequestPhase;
  requestError?: string | null;
}

function RequestAction({ onRequest, phase, error }: { onRequest: () => void; phase: CoverageRequestPhase; error: string | null }) {
  if (phase === "done" || phase === "already") {
    return (
      <span role="status" data-coverage-feedback="requested" className="cl-coverage-feedback">
        {phase === "already" ? "Already requested. It is in the coverage queue." : "Requested. It is recorded in the coverage queue."}
      </span>
    );
  }
  return (
    <span className="cl-coverage-actions">
      <Button variant="secondary" size="sm" disabled={phase === "sending"} onClick={onRequest}>
        {phase === "sending" ? "Requesting..." : "Request coverage"}
      </Button>
      {(phase === "failed" || error) && (
        <span role="alert" data-coverage-feedback="failed" className="cl-coverage-feedback cl-coverage-feedback--error">
          {error ?? "Could not record that. Try again."}
        </span>
      )}
    </span>
  );
}

/** The six coverage states in block, inline and cell forms. The cell form is the dash with the explanation on aria-label and title. */
export function CoverageState(props: CoverageStateProps) {
  const { state, subject, variant = "block", fallback = null } = props;
  const d = describeCoverageState({
    state: state ?? "",
    subject,
    reason: props.reason ?? null,
    reasonClass: props.reasonClass ?? null,
    roadmap: props.roadmap ?? null,
    requestRef: props.requestRef ?? null,
    lastValue: props.lastValue ?? null,
    asOf: props.asOf ?? null,
    expectedRefresh: props.expectedRefresh ?? null,
    hiddenCount: props.hiddenCount ?? null,
    noun: props.noun ?? null,
    canWiden: typeof props.onWiden === "function",
    canRetry: typeof props.onRetry === "function" || !!props.retryHref,
    statusHref: props.statusHref ?? null,
  });
  if (!d) return <>{fallback}</>;
  if (variant === "cell" || d.suppress) {
    const explanation = [`${d.label}: ${d.headline}`, ...d.lines].join(" ");
    return (
      <span className="cl-absence-dash" data-absence="dash" data-part="coverage-state" data-coverage-state={d.code} data-part-variant="cell" aria-label={explanation} title={explanation}>
        {ABSENCE_DASH}
      </span>
    );
  }
  const isError = d.code === "error";
  return (
    <div role={d.role} data-part="coverage-state" data-coverage-state={d.code} data-part-variant={variant} className={`cl-coverage cl-coverage--${variant}${isError ? " cl-coverage--error" : ""}`}>
      <div className="cl-coverage-body">
        <span data-part-slot="state-label" className={`cl-absence${isError ? " cl-absence--error" : ""}`}>
          {d.label}
        </span>
        <p className="cl-coverage-headline" {...(isError ? { role: "alert", "data-part": "state-note" } : {})}>{d.headline}</p>
        {d.lines.map((line) => (
          <p key={line} className="cl-coverage-line">
            {line}
          </p>
        ))}
      </div>
      {d.actions.length > 0 && (
        <div className="cl-coverage-actions">
          {d.actions.map((a) => {
            if (a.kind === "request" && props.requestRef && props.onRequest) return <RequestAction key={a.kind} onRequest={props.onRequest} phase={props.requestPhase ?? "idle"} error={props.requestError ?? null} />;
            if (a.kind === "widen" && props.onWiden)
              return (
                <Button key={a.kind} variant="secondary" size="sm" onClick={props.onWiden}>
                  {a.label}
                </Button>
              );
            if (a.kind === "retry" && props.onRetry)
              return (
                <Button key={a.kind} variant="secondary" size="sm" onClick={props.onRetry}>
                  {a.label}
                </Button>
              );
            const href = a.kind === "retry" ? props.retryHref : a.kind === "status" ? props.statusHref : null;
            return href ? (
              <a key={a.kind} href={href} className="cl-coverage-link">
                {a.label}
              </a>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
