"use client";

// Ported from old_repo/src/components/ui/ItemGroup.tsx (lines 53-160)
// Ported from old_repo/src/components/shared/MoreBelowDisclosure.tsx (lines 1-38)
// Ported from old_repo/src/components/ui/DetailSubSection.tsx (lines 1-25)
import type { ReactNode } from "react";

import type { UrgencyBand } from "@/core/lists";
import { formatNumber } from "@/core/shared";

import { BandGroupHeader } from "./BandParts";
import { SectionLabel } from "./SectionLabel";
import { StateNote, useBandContext } from "./StateNote";

/** The one closed-by-default overflow disclosure ("N more below"); a closed disclosure is the rule for accordions (ui-checks: details-open). */
export function MoreBelowDisclosure({ count, itemNoun = "more", children }: { count: number; itemNoun?: string; children: ReactNode }) {
  if (count <= 0) return null;
  return (
    <details className="cl-more-below">
      <summary className="cl-more-below-summary">
        {formatNumber(count)} {itemNoun} below
      </summary>
      <div className="cl-more-below-body">{children}</div>
    </details>
  );
}

const VISIBLE_CARD_CAP = 4;

/** A fact-card group: a band header, at most four cards then a disclosure, and the ACTION strip from the page's band context. The band pill shows only when passed explicitly. */
export function ItemGroup({ title, qualifier, band: bandProp, actionStrip: stripProp, children }: { title?: string | null; qualifier?: string | null; band?: UrgencyBand | null; actionStrip?: { text: string } | null; children: ReactNode[] }) {
  const ctx = useBandContext();
  const band = bandProp ?? ctx.band;
  const pillBand = bandProp ?? null;
  const strip = stripProp ?? (ctx.action ? { text: ctx.action } : null);
  const cards = Array.isArray(children) ? children : [children];
  const overflow = cards.slice(VISIBLE_CARD_CAP);
  return (
    <div data-part="item-group" className="cl-item-group">
      {(title || pillBand) && (
        <div data-part-slot="group-header">
          <BandGroupHeader band={pillBand ?? band} nameSlot="band-pill" right={qualifier ? <span className="cl-item-group-qualifier">{qualifier}</span> : undefined}>
            {title && (
              <span data-guard-title className="cl-item-group-title">
                {title}
              </span>
            )}
          </BandGroupHeader>
        </div>
      )}
      <div data-part-slot="group-body" className="cl-item-group-body">
        {cards.slice(0, VISIBLE_CARD_CAP)}
        {overflow.length > 0 && (
          <MoreBelowDisclosure count={overflow.length} itemNoun="more facts">
            {overflow}
          </MoreBelowDisclosure>
        )}
      </div>
      {strip && (
        <div data-part-slot="action-strip" className="cl-item-group-strip">
          <StateNote band={band}>
            <strong className="cl-item-group-action" style={{ color: band ? band.cssVar : "var(--brand)" }}>
              ACTION
            </strong>{" "}
            {strip.text}
          </StateNote>
        </div>
      )}
    </div>
  );
}

/** A detail sub-heading with an optional subtitle and a divider above (except the first). */
export function DetailSubSection({ title, subtitle, first = false, children }: { title: string; subtitle?: string | null; first?: boolean; children: ReactNode }) {
  return (
    <div>
      {!first && <div className="cl-sub-rule" aria-hidden="true" />}
      <SectionLabel>{title}</SectionLabel>
      {subtitle && <p className="cl-sub-subtitle">{subtitle}</p>}
      <div style={{ marginTop: subtitle ? 0 : "var(--sp-12)" }}>{children}</div>
    </div>
  );
}
