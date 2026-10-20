// Ported from old_repo/src/components/ui/SectionCard.tsx (lines 73-167)
// Ported from old_repo/src/components/ui/SectionRule.tsx (lines 27-38)
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

interface SectionCardProps {
  children: ReactNode;
  as?: "div" | "section" | "header" | "aside" | "article" | "li";
  padding?: string | number;
  dataAudit?: string;
  className?: string;
  id?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  dataAttributes?: Record<string, string>;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  /** A band-grouped list draws its own band rule, so the dark-grey rule is left off. */
  suppressRuleForBandGrouping?: boolean;
}

/** The 3 px dark-grey graduated rule, part of the card (ruling A1, 2026-09-08), never a decoration. */
const SectionRule = () => <div aria-hidden="true" className="cl-section-rule" />;

/** THE card shell: every card on every surface is this part. A padded card floats the rule over its top edge; a flow card stacks it. */
export function SectionCard({ children, as: Tag = "div", padding, dataAudit, className, id, style, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, suppressRuleForBandGrouping = false, dataAttributes, onKeyDown }: SectionCardProps) {
  const padded = padding !== undefined;
  return (
    <Tag
      {...dataAttributes}
      id={id}
      className={`cl-card${className ? ` ${className}` : ""}`}
      data-audit={dataAudit}
      data-section-card={suppressRuleForBandGrouping ? "band-grouping" : ""}
      data-guard-card=""
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onKeyDown={onKeyDown}
      style={{ ...style, ...(padded ? { position: "relative", padding } : null) }}
    >
      {suppressRuleForBandGrouping ? null : padded ? (
        <div aria-hidden="true" className="cl-card-rule-float">
          <SectionRule />
        </div>
      ) : (
        <SectionRule />
      )}
      {children}
    </Tag>
  );
}
