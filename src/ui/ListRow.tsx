// Ported from old_repo/src/components/ui/ListRow.tsx (lines 52-137)
// Ported from old_repo/src/components/ui/ListRow.tsx (lines 555-555)
// Ported from old_repo/src/components/ui/ListRow.tsx (lines 713-985)
// The one list row (ROWS-1, operator look ruling 2026-10-26): the short name, one line of stored reader text and one meta line, for every row type. The field set is data (list-surface/data/row-fields.json); this file draws nothing that file does not name.
// Class names only: every layout rule lives once in base.css, so a 100-row list carries the CSS once.
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";

import { displayTitle } from "@/core/lists/display-title";
import { itemTypeLabel } from "@/core/lists/item-type";
import type { UrgencyBand } from "@/core/lists";

import { Absence } from "./Absence";
import type { AbsenceReason } from "./absence-reason";
import { TagChip, TierChip } from "./Chips";
import rowFields from "./list-surface/data/row-fields.json";
import { RowMeta } from "./RowMeta";

const FIELDS = z
  .object({
    rowTypes: z.record(z.string(), z.object({ itemTypes: z.array(z.string()), name: z.enum(["act_short_name", "source_title"]), meta: z.array(z.string()) })),
    defaultRowType: z.string(),
    fields: z.record(z.string(), z.object({ absence: z.enum(["omit", "dash"]), drop: z.number().optional(), reason: z.string().optional(), labels: z.record(z.string(), z.string()).optional() })),
  })
  .parse(rowFields);

/** The row type of a stored item_type (or of a row type's own name): which fields the row draws. */
const rowTypeOf = (itemType: string | null | undefined): string => (itemType && FIELDS.rowTypes[itemType] ? itemType : (Object.entries(FIELDS.rowTypes).find(([, t]) => t.itemTypes.includes(itemType ?? ""))?.[0] ?? FIELDS.defaultRowType));

export interface ListRowProps {
  /** Where the row opens; absent for a row with no page (a watched source), which draws as a row without the link layer. */
  href?: string | undefined;
  band: UrgencyBand;
  /** The stored item_type (or "post", a community post): picks the row type. */
  itemType?: string | null | undefined;
  /** A kind the item-type table does not hold (a watched source, a portfolio entity); drawn as the type chip. */
  typeLabel?: string | null | undefined;
  /** The code of the item's jurisdiction; empty or absent draws no chip. */
  jurisdiction?: string | null | undefined;
  title: string;
  /** The stored reader text (what_is_it), drawn on one line; absent draws no line. */
  summary?: string | null | undefined;
  /** null: the surface read dates and the item has none (the quiet dash); undefined: this surface reads none (nothing drawn). */
  due?: { label: string; days: string } | null | undefined;
  /** null: the item's source has no rating (the quiet dash); undefined: this surface reads none. */
  tier?: number | null | undefined;
  /** A key of the `change` labels in row-fields.json (the dashboard's What changed section). */
  change?: string | null | undefined;
  /** A community post's group name. */
  group?: string | null | undefined;
  /** The last control in the row (the watch star or the overflow menu); it never shares a box with the row link. */
  overflow?: ReactNode;
}

function field(key: string, p: ListRowProps): ReactNode {
  const spec = FIELDS.fields[key]!;
  const chip = (text: string | null | undefined): ReactNode => (text ? <TagChip variant="row">{text}</TagChip> : null);
  const dash = <Absence reason={spec.reason as AbsenceReason} variant="dash" />;
  const node: ReactNode =
    key === "jurisdiction" ? chip(p.jurisdiction)
    : key === "type" ? chip(p.typeLabel ?? itemTypeLabel(p.itemType))
    : key === "group" ? chip(p.group)
    : key === "change" ? chip(p.change ? spec.labels?.[p.change] : null)
    : key === "due" ? (p.due === undefined ? null : p.due ? <span className="cl-row-due">{p.due.label} · {p.due.days}</span> : dash)
    : key === "tier" ? (p.tier === undefined ? null : p.tier !== null ? <TierChip tier={p.tier} /> : dash)
    : null;
  return node && spec.drop ? <span key={key} data-field={key} data-drop={spec.drop} className="cl-row-chip">{node}</span> : node ? <span key={key} data-field={key} className="cl-row-chip">{node}</span> : null;
}

export function ListRow(p: ListRowProps) {
  const type = FIELDS.rowTypes[rowTypeOf(p.itemType)]!;
  const name = displayTitle(p.title, true);
  return (
    <div className="cl-list-row" data-part="list-row" data-part-variant="list" style={{ ["--row-band" as string]: p.band.cssVar }}>
      <span className="cl-row-spine" aria-hidden="true" style={{ background: p.band.cssVar }} />
      {/* The link keeps the full official title as its name: the row shows the short name, a screen reader gets the whole act. */}
      {p.href && <Link href={p.href} prefetch={false} className="cl-row-link" aria-label={p.title} />}
      <div className="cl-row-content">
        <span data-guard-title className="cl-row-title">
          {name}
        </span>
        {p.summary && <span className="cl-row-summary">{p.summary}</span>}
        <RowMeta>{type.meta.map((key) => field(key, p))}</RowMeta>
      </div>
      <span className="cl-row-overflow">{p.overflow}</span>
    </div>
  );
}

/** The list header over the one row grid: the title column's label. */
export function ListRowHeader({ titleLabel = "Title" }: { titleLabel?: string }) {
  return (
    <div className="cl-list-row-header" data-part="list-row-header">
      <span aria-hidden="true" />
      <span data-part-slot="column-label">{titleLabel}</span>
      <span aria-hidden="true" />
    </div>
  );
}
