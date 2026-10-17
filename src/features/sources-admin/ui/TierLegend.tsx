"use client";

// Ported from old_repo/src/components/sources/SourceTierLegend.tsx (lines 28-262)
import { formatNumber } from "@/core/shared";
import { customerTierOf, tierContract, TIER_LABELS } from "@/core/sources/tier-contract";
import { Button, Dialog, FilterChip, FilterChipGroup, TierChip } from "@/ui";

export const SOURCE_TIERS = tierContract.tiers.map((t) => t.tier);

type TierColumns = { base_tier: number; effective_tier: number | null; tier_override: number | null };

/** How many sources sit at each tier, counted by the tier a customer sees (override, then effective, then base): the facet counts with the same function the filter matches on. Pure. */
export function tierCounts(sources: readonly TierColumns[]): Record<number, number> {
  const out: Record<number, number> = Object.fromEntries(SOURCE_TIERS.map((t) => [t, 0]));
  for (const s of sources) {
    const t = customerTierOf(s);
    if (t !== null && t in out) out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/** The scale in one row: the seven tiers with their labels, and a 44 px control that opens the definitions. */
export function TierLegend({ onOpenDefinitions }: { onOpenDefinitions: () => void }) {
  return (
    <div data-audit="tier-legend" className="cl-filter-group">
      <span className="cl-filter-group-label">Tiers</span>
      <span className="cl-filter-group-chips">
        {SOURCE_TIERS.map((t) => (
          <span key={t} role="img" title={`T${t} · ${TIER_LABELS[t]}`} aria-label={`T${t}, ${TIER_LABELS[t]}`}><TierChip tier={t} /></span>
        ))}
      </span>
      <Button variant="ghost" size="sm" onClick={onOpenDefinitions}>Tier definitions</Button>
    </div>
  );
}

/** The tier facet: one chip per tier with its count. */
export function TierFacet({ counts, active, onToggle }: { counts: Record<number, number>; active: readonly number[]; onToggle: (tier: number) => void }) {
  return (
    <div data-audit="tier-facet">
      <FilterChipGroup label="Tier">
        {SOURCE_TIERS.map((t) => <FilterChip key={t} active={active.includes(t)} onClick={() => onToggle(t)}>T{t} {formatNumber(counts[t] ?? 0)}</FilterChip>)}
      </FilterChipGroup>
    </div>
  );
}

/** The definitions of the seven tiers in the kit dialog (Esc, focus kept inside, focus returned to the opener). */
export function TierDefinitionsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Source tier definitions">
      <ul className="cl-form-body">
        {tierContract.tiers.map((t) => (
          <li key={t.tier}>
            <TierChip tier={t.tier} /> <b>{t.label}</b>
            <p className="cl-field-hint">{t.meaning}{t.examples.length ? ` Examples: ${t.examples.join(", ")}.` : ""}</p>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
