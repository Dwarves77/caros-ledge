"use client";

// Ported from old_repo/src/components/regulations/BindingBanner.tsx (lines 30-228)
// The item-level binding-position banner (spec 01 section 4, component 1): for each position (your duty, carrier pass-through, customer contract, monitor) who holds the duty, why it is in scope,
// whether it applies to the reader's organisation, and the three cost slots kept apart. An item with no decomposed obligations says so; a failed load says so with Retry.

import { OBS_STATUS } from "@/core/contracts/vocabularies";
import type { ObligationBinding } from "@/core/workspace";
import { Button, ButtonLink, SectionCard } from "@/ui";

import type { RelevanceFetch } from "./useItemRelevance";

const STATUS_TEXT = { applies: "Applies to your organisation", does_not_apply: "Does not apply to your organisation", needs_profile_input: "Needs your organisation profile" } as const;
/** One short label per classified attribute, comparison, token and artifact class (the data-file tokens in words; never a sentence about the regulation). */
const ATTRIBUTE_LABEL: Readonly<Record<string, string>> = { void_space_ratio: "Void space ratio", recycled_content: "Recycled content", de_minimis_weight: "De minimis weight", tonnage_cutoff: "Tonnage cutoff", exemption_scope: "Exemption scope", labeling_marking_class: "Marking class" };
const COMPARISON_LABEL: Readonly<Record<string, string>> = { "<=": "at most", ">=": "at least", "<": "below" };
const TOKEN_LABEL: Readonly<Record<string, string>> = { b2b_transport_packaging: "B2B transport packaging", reusable_closed_loop: "Reusable closed-loop systems", critical_performance_factors: "Critical performance factors", material_composition_sorting: "Material composition and sorting", reusable_qr_data_carrier: "Reusable system, QR code or data carrier" };
const ARTIFACT_LABEL: Readonly<Record<string, string>> = { declaration_of_conformity: "Declaration of conformity", conformity_assessment_technical_documentation: "Conformity assessment or technical documentation", producer_register: "Producer register" };

type Trigger = ObligationBinding["lines"][number]["triggers"][number];
/** A classified trigger as its parts: the attribute's label, the comparison, and the value as the text states it, the token's label, or the stated absence from the obs_status vocabulary. */
const statedValue = (t: Trigger): string => (t.obsStatus ? (OBS_STATUS[t.obsStatus]?.label ?? t.obsStatus) : `${t.comparison ? `${COMPARISON_LABEL[t.comparison] ?? t.comparison} ` : ""}${(t.value && TOKEN_LABEL[t.value]) || t.value || ""}`);

const muted = { fontSize: "var(--fs-125)", color: "var(--ink-3)", margin: 0, lineHeight: 1.45, overflowWrap: "anywhere" } as const;

function Line({ line }: { line: ObligationBinding["lines"][number] }) {
  const status = line.applicability?.status;
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--sp-4) var(--sp-10)" }}>
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
      {line.triggers.some((t) => t.attribute in ATTRIBUTE_LABEL) && (
        <ul style={{ ...muted, paddingLeft: "var(--sp-18)" }}>
          {line.triggers.filter((t) => t.attribute in ATTRIBUTE_LABEL).map((t) => (
            <li key={`${t.attribute}|${t.value}`}>
              <strong>{ATTRIBUTE_LABEL[t.attribute]}: </strong>
              {statedValue(t)}
            </li>
          ))}
        </ul>
      )}
      {line.artifacts.length > 0 && (
        <ul style={{ ...muted, paddingLeft: "var(--sp-18)" }}>
          {line.artifacts.map((a) => (
            <li key={`${a.class}|${a.name}`}>
              <strong>{ARTIFACT_LABEL[a.class] ?? a.class}: </strong>“{a.name}”
            </li>
          ))}
        </ul>
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
    <section id="binding-banner" aria-labelledby="binding-banner-title" className="cl-detail-wrap" style={{ marginTop: "var(--sp-24)", paddingBottom: 0 }}>
      <SectionCard padding="14px 16px">
        <h2 id="binding-banner-title" data-guard-title style={{ fontSize: "var(--fs-13)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink)", margin: 0 }}>
          How this regulation reaches you
        </h2>
        {relevance.phase === "loading" ? (
          <p role="status" aria-live="polite" style={{ ...muted, marginTop: "var(--sp-8)" }}>
            Checking which obligations reach your organisation…
          </p>
        ) : relevance.phase === "failed" || !binding ? (
          <div style={{ marginTop: "var(--sp-8)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-12)" }}>
            <p role="alert" data-part="state-note" style={{ ...muted, flex: "1 1 220px" }}>
              The obligation positions for this regulation could not be loaded. The rest of the page is unaffected.
            </p>
            <Button onClick={retry}>
              Try again
            </Button>
          </div>
        ) : !binding.decomposed || binding.lines.length === 0 ? (
          <div style={{ marginTop: "var(--sp-8)" }}>
            <p style={{ fontSize: "var(--fs-13)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>Obligations not yet decomposed</p>
            <p style={{ ...muted, marginTop: "var(--sp-4)" }}>This regulation has not been broken into individual obligations yet. The dated events below are listed as they were extracted.</p>
          </div>
        ) : (
          <div style={{ marginTop: "var(--sp-8)" }}>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--sp-14)" }}>
              {binding.lines.map((line) => (
                <Line key={line.position} line={line} />
              ))}
            </ul>
            {binding.lines.some((l) => l.applicability?.status === "needs_profile_input") && (
              <div style={{ marginTop: "var(--sp-14)" }}>
                <ButtonLink href="/settings" prefetch={false}>
                  Open organisation profile
                </ButtonLink>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
