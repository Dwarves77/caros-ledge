// Ported from old_repo/src/components/ui/Masthead.tsx (lines 52-290)
// Ported from old_repo/src/lib/render-now.ts (lines 1-11)
import type { ReactNode } from "react";

import { normalizeDisplayTitle } from "@/core/fetch/titles";

import { weekOfIso } from "./iso-week";
import { SectionCard } from "./SectionCard";
import { StateNote } from "./StateNote";

interface MastheadProps {
  title: string;
  size?: "list" | "detail";
  dek?: ReactNode;
  dateLabel: string;
  /** The render instant: required, so the masthead never reads a clock in render (B-0209). */
  nowIso: string;
  /** The editorial volume (roman numeral); a prop, not a literal in the part. */
  volume?: string;
  /** The command bar slot; the shell fills it. A masthead without one keeps the flex row at every width. */
  commandBar?: ReactNode;
  eyebrowSuffix?: string;
  notice?: { text: ReactNode; linkLabel?: string; linkHref?: string };
  actionSlot?: ReactNode;
  connectionsSlot?: ReactNode;
}

/** The frame masthead: the VOL and ISO-week line, the Anton title, a dek, the command bar slot, a notice and the action and connections slots. */
export function Masthead({ title, size = "list", dek, dateLabel, nowIso, volume = "IV", commandBar, eyebrowSuffix, notice, actionSlot, connectionsSlot }: MastheadProps) {
  const { title: displayTitle, subtitle } = normalizeDisplayTitle(title);
  return (
    <SectionCard as="header" className="cl-masthead" dataAttributes={commandBar ? { "data-masthead-size": size, "data-masthead-cmdbar": "" } : { "data-masthead-size": size }}>
      <div className="cl-masthead-body">
        <p className="cl-masthead-eyebrow">
          VOL {volume} · No. {weekOfIso(nowIso)} · {dateLabel}
          {eyebrowSuffix ? ` · ${eyebrowSuffix}` : ""}
        </p>
        <div className="cl-masthead-row">
          <div className="cl-masthead-titleblock">
            <h1 data-guard-title data-guard-display="page-title" className="cl-masthead-title">
              {displayTitle}
            </h1>
            {subtitle && <p className="cl-masthead-subtitle">{subtitle}</p>}
            {dek && <div className="cl-masthead-dek">{dek}</div>}
          </div>
          {commandBar && <div className="cl-masthead-cmdbar">{commandBar}</div>}
        </div>
      </div>
      {notice && (
        <div className="cl-masthead-notice">
          <StateNote {...(notice.linkLabel && notice.linkHref ? { action: { label: notice.linkLabel, href: notice.linkHref } } : {})}>{notice.text}</StateNote>
        </div>
      )}
      {actionSlot && <div className="cl-masthead-slot">{actionSlot}</div>}
      {connectionsSlot && <div className="cl-masthead-slot">{connectionsSlot}</div>}
    </SectionCard>
  );
}
