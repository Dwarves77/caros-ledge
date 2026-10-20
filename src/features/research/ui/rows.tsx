"use client";

// Ported from old_repo/src/components/research/ResearchLedger.tsx (lines 358-424)
// Ported from old_repo/src/components/operations/OperationsLedger.tsx (lines 448-481)
// The two category ledgers composed their band-grouped rows identically (the register's "each ledger becomes its facets plus its above-rows slot"): one mapper here, used by Research and Operations. A row is one
// link to the detail page carrying the list position, the shared row fields, the overflow menu (a 44 px trigger; Open and Copy link), and the band it sits in.
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { BAND_ORDER, bandFromPriority, toListRowFields, type UrgencyBand, type UrgencyBandKey } from "@/core/lists";
import type { Resource } from "@/core/types";
import { Menu, Toast } from "@/ui";
import { RowWatch } from "@/features/watchlist/ui/RowActions";
import type { WatchlistItemType } from "@/features/watchlist/links";
import { withListPosition } from "@/ui/list-surface";
import type { ListRowProps } from "@/ui/ListRow";

/** The row overflow menu: Open, Copy link and the watchlist's own Watch control (RowWatch, inside the one 44 px overflow). */
function RowMenu({ label, href, type, id }: { label: string; href: string; type: WatchlistItemType; id: string }) {
  const router = useRouter();
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      setNote({ text: "Link copied", error: false });
    } catch {
      setNote({ text: "Copy failed. Open the item and copy the address from the browser bar.", error: true });
    }
  };
  return (
    <>
      <Menu label={label} extra={<RowWatch type={type} id={id} />} items={[{ key: "open", label: "Open", onSelect: () => router.push(href) }, { key: "copy", label: "Copy link", onSelect: () => void copy() }]} />
      <Toast message={note?.text ?? ""} visible={note !== null} variant={note?.error ? "error" : "success"} onDismiss={() => setNote(null)} />
    </>
  );
}

export interface BandedSection {
  band: UrgencyBand;
  total: number;
  rows: Array<ListRowProps & { key: string }>;
}
export interface BandedOptions {
  /** The list's name on the detail-return contract (`list=research`). */
  list: string;
  /** The overflow menu's accessible name, e.g. "Research item actions". */
  menuLabel: string;
  /** The selected band tile, or null. */
  bandKey: UrgencyBandKey | null;
  now: Date;
  /** The row's meta line when the surface composes its own (a theme and a horizon); falls back to the shared one. */
  meta?: (r: Resource) => ReactNode;
  /** The row's kind tag (a severity); undefined draws none. */
  kind?: (r: Resource) => ReactNode;
}

/** The rows grouped by band in the one band order; a selected band empties the others. The detail link carries the position, the total and the neighbours in the band. */
export function bandedRows(rows: readonly Resource[], o: BandedOptions): BandedSection[] {
  return BAND_ORDER.map((band) => {
    const inBand = o.bandKey && o.bandKey !== band.key ? [] : rows.filter((r) => bandFromPriority(r.priority).key === band.key);
    return {
      band,
      total: inBand.length,
      rows: inBand.map((r, i) => {
        const f = toListRowFields(r, o.now);
        const kind = o.kind?.(r);
        return {
          key: r.id,
          href: withListPosition(f.href, o.list, i + 1, inBand.length, { prev: inBand[i - 1]?.id ?? null, next: inBand[i + 1]?.id ?? null }),
          band, jurisdiction: f.jurisdiction, title: f.title, meta: o.meta ? o.meta(r) : f.meta, ...(kind ? { kind } : {}), impact: f.impact, due: f.due, timeline: f.timeline, tier: f.tier,
          ...(f.biasTags ? { biasTags: f.biasTags } : {}), ...(f.itemGrade ? { itemGrade: f.itemGrade } : {}), overflow: <RowMenu label={o.menuLabel} href={f.href} type={o.list === "operations" ? "operations" : "research"} id={r.id} />,
        };
      }),
    };
  });
}
