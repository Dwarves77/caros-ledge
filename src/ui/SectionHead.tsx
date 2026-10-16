// Ported from old_repo/src/components/ui/SectionHeader.tsx (lines 36-116)
// Ported from old_repo/src/components/ui/SectionHeading.tsx (lines 33-113)
// Ported from old_repo/src/components/ui/section-title-style.ts (lines 1-12)
import type { ReactNode } from "react";

interface SectionHeadProps {
  title: ReactNode;
  /** The S-section ordinal, drawn before the title. */
  index?: string | null;
  /** The right-hand eyebrow (meta or aside). */
  aside?: ReactNode;
  /** `rule` draws the divider under an S-section head; a card head draws none (rulings 4.1 and 5.1). */
  rule?: boolean;
  /** `section` pads 14/20/10, `card` pads 14/16/10. */
  padding?: "section" | "card";
  /** `detail` is the 24 px title on the band tint a detail section carries. */
  size?: "default" | "detail";
  /** The card title never wraps at any width; the S-section title may. */
  nowrapTitle?: boolean;
}

/** The one section head: the S-section head (index, title, meta, rule) and the card head (title, aside) are two prop sets of this part. */
export function SectionHead({ title, index, aside, rule = false, padding = "card", size = "default", nowrapTitle = false }: SectionHeadProps) {
  const cls = `cl-section-head2 cl-section-head2--${padding}${rule ? " cl-section-head2--rule" : ""}${size === "detail" ? " cl-section-head2--detail" : ""}`;
  return (
    <div data-part="section-head" className={cls}>
      <div className="cl-section-head2-titlewrap">
        {index && (
          <span data-part-slot="section-index" className="cl-section-head2-index">
            {index}
          </span>
        )}
        <h2 data-guard-title data-guard-display="card-title" className="cl-section-title" style={nowrapTitle ? { whiteSpace: "nowrap" } : undefined}>
          {title}
        </h2>
      </div>
      {aside ? (
        <span data-part-slot="section-meta" className="cl-section-head2-aside">
          {aside}
        </span>
      ) : null}
    </div>
  );
}
