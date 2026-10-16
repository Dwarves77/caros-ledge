// Ported from old_repo/src/components/ui/Chips.tsx (lines 23-381)
// Ported from old_repo/src/components/ui/FactCard.tsx (lines 205-225)
import type { ReactNode } from "react";

import type { UrgencyBand } from "@/core/lists";

import { clampTier } from "./tier";

export function BandChip({ band, withWindow }: { band: UrgencyBand; withWindow?: boolean }) {
  return (
    <span data-part="chip-band" className="cl-chip-band" style={{ color: band.cssVar, background: band.tintCssVar, border: `1px solid ${band.borderCssVar}` }}>
      <span aria-hidden="true" className="cl-chip-band-dot" style={{ background: band.cssVar }} />
      {band.label}
      {withWindow && band.window ? ` · ${band.window}` : ""}
    </span>
  );
}

/** The tier square: the only bordered chip (chip family rule 2.5), one ceiling, every surface. `square` is the 20x18 box a fact card's provenance column draws. */
export function TierChip({ tier, size = "chip" }: { tier: number; size?: "chip" | "square" }) {
  const t = clampTier(tier);
  return (
    <span className={size === "square" ? "cl-tier-square" : "cl-tier-chip"} data-part="chip-tier" title={size === "square" ? `Tier ${t} - provenance, never urgency` : undefined}>
      T{t}
    </span>
  );
}

export const TagChip = ({ children, variant = "detail" }: { children: ReactNode; variant?: "detail" | "row" }) => (
  <span className={variant === "row" ? "cl-tag-chip cl-tag-chip-row" : "cl-tag-chip"} data-part="chip-tag">
    {children}
  </span>
);

/** A workspace tag. The remove control is a 24 px target with 8 px clearance (law 2). */
export function WorkspaceTagPill({ name, onRemove, title }: { name: string; onRemove?: () => void; title?: string }) {
  return (
    <span data-part="chip-workspace-tag" title={title} className={onRemove ? "cl-ws-tag cl-ws-tag--removable" : "cl-ws-tag"}>
      <span aria-hidden="true" className="cl-ws-tag-dot" />
      {name}
      {onRemove && (
        <button
          type="button"
          className="cl-ws-tag-remove"
          aria-label={`Remove tag ${name}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

export const FilterChipGroup = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="cl-filter-group" data-part="chip-filter-group">
    <span className="cl-filter-group-label">{label}</span>
    <div className="cl-filter-group-chips">{children}</div>
  </div>
);

export const FilterChip = ({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: ReactNode }) => (
  <button type="button" className="cl-filter-chip" data-part="chip-filter" data-active={active ? "true" : "false"} onClick={onClick} aria-pressed={active}>
    {children}
  </button>
);

/** The catalogue-record chip: record-grade items only. */
export function GradeChip({ itemGrade }: { itemGrade?: "record" | "brief" | undefined }) {
  if (itemGrade !== "record") return null;
  return (
    <span data-part="chip-grade" className="cl-grade-chip" title="Catalogue record: every fact below is quoted directly from the source document. A synthesized full brief is a separate, later upgrade for this item.">
      Catalogue record
    </span>
  );
}
