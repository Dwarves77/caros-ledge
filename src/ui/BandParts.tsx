// Ported from old_repo/src/components/ui/BandGradientRule.tsx (lines 17-48)
// Ported from old_repo/src/components/ui/BandGroupHeader.tsx (lines 17-82)
// Ported from old_repo/src/components/ui/BandTile.tsx (lines 23-201)
// Ported from old_repo/src/components/ui/BandTileRow.tsx (lines 27-45)
import Link from "next/link";
import type { ReactNode } from "react";

import { BAND_ORDER, type UrgencyBand } from "@/core/lists";
import { formatNumber } from "@/core/shared";

/** The 3 px band-proportion brand rule. Band hexes are the declared literal exception (gradient stops cannot be var() chains). */
export function BandGradientRule({ counts, height = 3 }: { counts: Record<string, number> | null; height?: number }) {
  if (counts === null) return <div aria-hidden="true" className="cl-band-rule cl-band-rule--unknown" style={{ height }} />;
  const total = BAND_ORDER.reduce((sum, b) => sum + (counts[b.key] ?? 0), 0);
  let from = 0;
  const stops = BAND_ORDER.map((b) => {
    const to = from + (total > 0 ? ((counts[b.key] ?? 0) / total) * 100 : 25);
    const part = `${b.hex} ${from}%, ${b.hex} ${to}%`;
    from = to;
    return part;
  }).join(", ");
  return <div aria-hidden="true" className="cl-band-rule" style={{ height, background: `linear-gradient(90deg, ${stops})` }} />;
}

/** The one band group header: white, Anton 18 in the band colour, the definition in grey, the 3 px band rule on top (artboard 22 ruling A). */
export function BandGroupHeader({ band, children, right, nameSlot }: { band: UrgencyBand | null; children?: ReactNode; right?: ReactNode; nameSlot?: string }) {
  return (
    <div data-audit="band-header" className="cl-band-group-head" style={band ? { borderTop: `3px solid ${band.cssVar}` } : undefined}>
      <span className="cl-band-group-head-main">
        {band && (
          <>
            <span data-audit="band-header-label" data-guard-display="band-group-name" data-part-slot={nameSlot} className="cl-band-group-name" style={{ color: band.cssVar }}>
              {band.label}
            </span>
            <span data-audit="band-header-window" title={band.window} className="cl-band-group-window">
              {band.window}
            </span>
          </>
        )}
        {children}
      </span>
      {right}
    </div>
  );
}

interface BandTileProps {
  band: UrgencyBand;
  count: number | null;
  /** A count still loading draws a skeleton, never 0. */
  loading?: boolean;
  selected?: boolean;
  onSelect?: (bandKey: UrgencyBand["key"]) => void;
  href?: string;
}

function BandTileBody({ band, count, loading }: Pick<BandTileProps, "band" | "count" | "loading">) {
  return (
    <>
      <span className="cl-band-tile-head">
        <span className="cl-band-tile-label" style={{ color: band.cssVar }}>
          {band.label}
        </span>
        <span className="cl-band-tile-window" title={band.window}>
          {band.window}
        </span>
      </span>
      {loading || count === null ? (
        <span aria-hidden="true" className="cl-band-tile-skel" />
      ) : (
        <span className="cl-band-tile-numeral" data-guard-display="band-tile-numeral" style={{ color: band.cssVar }}>
          {formatNumber(count)}
        </span>
      )}
      <span aria-hidden="true" className="cl-band-tile-rule" style={{ background: band.cssVar }} />
    </>
  );
}

/** The urgency band tile: a link or an in-place filter button. A null count draws the skeleton (INV-263: never a fabricated zero). */
export function BandTile({ band, count, loading, selected, onSelect, href }: BandTileProps) {
  const label = `${band.label} — ${band.window}${count != null ? `, ${formatNumber(count)} items` : ""}`;
  const body = <BandTileBody band={band} count={count} loading={loading} />;
  const cls = `cl-band-tile${selected ? " cl-band-tile--selected" : ""}${onSelect || href ? " cl-band-tile--live" : ""}`;
  if (href) {
    return (
      <Link href={href} aria-label={label} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => onSelect?.(band.key)} disabled={!onSelect} aria-pressed={selected} aria-label={label} className={cls}>
      {body}
    </button>
  );
}

/** The four-tile grid: 4 across, 2x2 on the phone. */
export const BandTileRow = ({ children, gap = 14 }: { children: ReactNode; gap?: number }) => (
  <div className="cl-band-tiles" style={{ gap }}>
    {children}
  </div>
);
