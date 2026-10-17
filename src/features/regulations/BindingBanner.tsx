"use client";

// Ported from old_repo/src/components/regulations/BindingBanner.tsx (lines 30-228)
// The item-level binding-position banner (spec 01 section 4, component 1): for each position (your duty, carrier pass-through, customer contract, monitor) who holds the duty, why it is in scope,
// whether it applies to the reader's organisation, and the three cost slots kept apart. An item with no decomposed obligations says so; a failed load says so with Retry.
import Link from "next/link";

import type { ObligationBinding } from "@/core/workspace";
import { Button, SectionCard } from "@/ui";

import type { RelevanceFetch } from "./useItemRelevance";

const STATUS_TEXT = { applies: "Applies to your organisation", does_not_apply: "Does not apply to your organisation", needs_profile_input: "Needs your organisation profile" } as const;
const muted = { fontSize: "var(--fs-125)", color: "var(--ink-3)", margin: 0, lineHeight: 1.45, overflowWrap: "anywhere" } as const;

function Line({ line }: { line: ObligationBinding["lines"][number] }) {
  const status = line.applicability?.status;
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px" }}>
        <span title={line.note} style={{ fontSize: "var(--fs-13)", fontWeight: 800, color: "var(--ink)" }}>
          {line.label}
        </span>
        {status && <span style={{ fontSize: "var(--fs-12)", fontWeight: 700, color: status === "applies" ? "var(--action)" : "var(--ink-3)" }}>{STATUS_TEXT[status]}</span>}
      </div>
      <p style={muted}>
        <strong>Duty holders: </strong>
        {line.dutyHolders.map((d) => d.label).join(", ")}
      </p>
      {line.triggers.length > 0 && (
        <p style={muted}>
          <strong>In scope because: </strong>
          {line.triggers.map((t) => t.label).join("; ")}
        </p>
      )}
      {line.applicability && line.applicability.status !== "applies" && line.applicability.reasons.length > 0 && <p style={muted}>{line.applicability.reasons.join(" ")}</p>}
      {line.costSlots.map((slot) => (
        <p key={slot.slot} style={muted}>
          <strong>{slot.label}: </strong>
          {slot.entries.join("; ")}
        </p>
      ))}
    </li>
  );
}

export function BindingBanner({ relevance, retry }: { relevance: RelevanceFetch; retry: () => void }) {
  const binding = relevance.phase === "ready" ? relevance.data.binding : null;
  return (
    <section id="binding-banner" aria-labelledby="binding-banner-title" className="cl-detail-wrap" style={{ marginTop: 24, paddingBottom: 0 }}>
      <SectionCard padding="14px 16px">
        <h2 id="binding-banner-title" data-guard-title style={{ fontSize: "var(--fs-13)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink)", margin: 0 }}>
          How this regulation reaches you
        </h2>
        {relevance.phase === "loading" ? (
          <p role="status" aria-live="polite" style={{ ...muted, marginTop: 8 }}>
            Checking which obligations reach your organisation…
          </p>
        ) : relevance.phase === "failed" || !binding ? (
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <p role="alert" style={{ ...muted, flex: "1 1 220px" }}>
              The obligation positions for this regulation could not be loaded. The rest of the page is unaffected.
            </p>
            <Button variant="primary" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : !binding.decomposed || binding.lines.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: "var(--fs-13)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>Obligations not yet decomposed</p>
            <p style={{ ...muted, marginTop: 4 }}>This regulation has not been broken into individual obligations yet. The dated events below are listed as they were extracted.</p>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 14 }}>
              {binding.lines.map((line) => (
                <Line key={line.position} line={line} />
              ))}
            </ul>
            {binding.lines.some((l) => l.applicability?.status === "needs_profile_input") && (
              <div style={{ marginTop: 14 }}>
                <Link href="/settings" prefetch={false} className="cl-btn cl-btn--primary cl-btn--md">
                  Open organisation profile
                </Link>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
