"use client";

// Ported from old_repo/src/components/ui/BiasChips.tsx (lines 36-255)
import { useId, useState } from "react";

import { biasChips, biasLegend, LOWER_CONFIDENCE_WORDS, type BiasTagInput } from "@/core/sources/bias-tags";

import { TagChip } from "./Chips";

type DisplayChip = ReturnType<typeof biasChips>["shown"][number];
const DIMENSION_LABEL: Record<string, string> = Object.fromEntries(biasLegend().map((g) => [g.dimension, g.label]));
const ROW_MAX = 2;
const DETAIL_MAX = 3;

const chipText = (c: DisplayChip): string => (c.lowerConfidence ? `${c.label} · ${LOWER_CONFIDENCE_WORDS}` : c.label);
function chipTitle(c: DisplayChip): string {
  const dim = c.dimension ? `${DIMENSION_LABEL[c.dimension] ?? c.dimension}: ` : "";
  return `${dim}${c.label}${c.lowerConfidence ? `, ${LOWER_CONFIDENCE_WORDS}` : ""}${c.confidencePct != null ? ` (${c.confidencePct}% confidence)` : ""}`;
}

const Chip = ({ c, variant }: { c: DisplayChip; variant: "row" | "detail" }) => (
  <span data-bias-tag={c.tag} data-lower-confidence={c.lowerConfidence ? "true" : "false"} title={chipTitle(c)} className="cl-bias-chip">
    <TagChip variant={variant}>{chipText(c)}</TagChip>
  </span>
);

/**
 * The customer bias display (INV-214): a source's tags in the three dimensions, never for Community content. Row: two chips and a count, no
 * interactive element. Detail: three chips and a disclosure for the rest. Below 0.80 a chip says "lower confidence".
 */
export function BiasChips({ tags, variant = "row", max, label }: { tags: BiasTagInput[] | null | undefined; variant?: "row" | "detail"; max?: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const d = biasChips(tags, max ?? (variant === "row" ? ROW_MAX : DETAIL_MAX));
  if (d.total === 0) return null;
  return (
    <span data-part="bias-chips" data-part-variant={variant} role="group" aria-label="Source bias tags" className={`cl-bias cl-bias--${variant}`}>
      {label && <span className="cl-bias-label">{label}</span>}
      {d.shown.map((c) => (
        <Chip key={c.key} c={c} variant={variant} />
      ))}
      {d.remaining > 0 && variant === "row" && (
        <span data-bias-more="count" title={d.rest.map((c) => c.label).join(", ")} className="cl-bias-more">
          +{d.remaining} more
        </span>
      )}
      {d.remaining > 0 && variant === "detail" && (
        <>
          <span id={panelId} className="cl-contents">
            {open && d.rest.map((c) => <Chip key={c.key} c={c} variant="detail" />)}
          </span>
          <button type="button" data-bias-more="disclosure" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)} className="cl-bias-more cl-bias-more--button">
            {open ? "Show fewer" : `+${d.remaining} more`}
          </button>
        </>
      )}
    </span>
  );
}

/** The whole vocabulary grouped by dimension, built from the data. */
export function BiasLegend() {
  return (
    <div data-part="bias-legend" className="cl-bias-legend">
      <span className="cl-bias-legend-title">Source bias tags</span>
      {biasLegend().map((g) => (
        <div key={g.dimension} className="cl-bias-legend-group">
          <span className="cl-bias-legend-dim">{g.label}</span>
          {g.tags.map((t) => (
            <TagChip key={t.tag} variant="row">
              {t.label}
            </TagChip>
          ))}
        </div>
      ))}
    </div>
  );
}
