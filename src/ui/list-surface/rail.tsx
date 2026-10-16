"use client";

// Ported from old_repo/src/components/list-surface/ListSurfaceRailCards.tsx (lines 45-252)
// Ported from old_repo/src/components/list-surface/ListSurfaceRailCards.tsx (lines 551-578)
import { useMemo, useState } from "react";

import { formatNumber } from "@/core/shared";
import { tierScaleSpan } from "@/core/sources";

import { ImpactMeter } from "../ImpactMeter";
import { RailCard } from "../SmallParts";

import type { FacetOption } from "./facets";

export interface FacetGroup {
  key: string;
  label: string;
  options: FacetOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}
const VISIBLE_OPTIONS = 6;

function FacetSection({ group }: { group: FacetGroup }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? group.options : group.options.slice(0, VISIBLE_OPTIONS);
  const hidden = group.options.length - visible.length;
  return (
    <div data-audit={`facet-${group.key}`} className="cl-facet-group">
      <p className="cl-facet-group-label">{group.label}</p>
      <div className="cl-facet-rows">
        {visible.map((opt) => {
          const checked = group.selected === opt.value;
          return (
            <label key={opt.value} className="cl-facet-row">
              <span className="cl-facet-row-main">
                <input type="checkbox" className="cl-facet-check" checked={checked} onChange={() => group.onSelect(checked ? null : opt.value)} />
                <span className="cl-facet-label">{opt.label}</span>
              </span>
              <span className="cl-facet-count">{opt.countLabel ?? formatNumber(opt.count)}</span>
            </label>
          );
        })}
      </div>
      {hidden > 0 && (
        <button type="button" className="cl-facet-more" onClick={() => setExpanded(true)}>
          + {formatNumber(hidden)} more
        </button>
      )}
    </div>
  );
}

/** The FILTERS rail card: checkbox facets with live counts, "+N more", "Clear N". Rows are 24 px on desktop and 44 px on touch (base.css). It carries no footnote. */
export function FiltersRailCard({ groups }: { groups: FacetGroup[] }) {
  const shown = useMemo(() => groups.filter((g) => g.options.length > 0), [groups]);
  const active = shown.filter((g) => g.selected !== null).length;
  if (shown.length === 0) return null;
  return (
    <RailCard
      title="Filters"
      dataAudit="filters-rail"
      headRight={
        <button type="button" onClick={() => shown.forEach((g) => g.onSelect(null))} disabled={active === 0} className="cl-facet-clear">
          {active === 0 ? "Clear" : `Clear ${active}`}
        </button>
      }
    >
      <div className="cl-facet-groups">
        {shown.map((g) => (
          <FacetSection key={g.key} group={g} />
        ))}
      </div>
    </RailCard>
  );
}

/** The legend: the impact meter at 8 of 12, the timeline words, and the source tier scale from the tier vocabulary. */
export function LegendRailCard() {
  return (
    <RailCard title="Legend" dataAudit="legend-rail">
      <dl className="cl-legend">
        <div>
          <dt>Impact</dt>
          <dd>
            <ImpactMeter total={8} valueVisible />
          </dd>
        </div>
        <div>
          <dt>Timeline</dt>
          <dd>Passed · next · ahead.</dd>
        </div>
        <div>
          <dt>Source tier</dt>
          <dd>{tierScaleSpan("→")}.</dd>
        </div>
      </dl>
    </RailCard>
  );
}
