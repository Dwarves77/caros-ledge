// Ported from old_repo/src/components/ui/FilePickRow.tsx (lines 13-57)
// Ported from old_repo/src/components/ui/SourceLink.tsx (lines 9-29)
// Ported from old_repo/src/components/ui/CardFoot.tsx (lines 40-113)
// Ported from old_repo/src/components/ui/RailCard.tsx (lines 28-132)
// Ported from old_repo/src/lib/tint.ts (lines 1-3)
import Link from "next/link";
import type { ChangeEvent, CSSProperties, ReactNode, RefObject } from "react";

import { SectionCard } from "./SectionCard";

/** A color-mix builder; kept for the admin callers that tint a token. */
export const tint = (cssVar: string, percent: number): string => `color-mix(in srgb, ${cssVar} ${percent}%, transparent)`;

export function FilePickRow({ label, hint, accept, onFile, icon, inputRef }: { label: string; hint: string; accept: string; onFile: (e: ChangeEvent<HTMLInputElement>) => void; icon?: ReactNode; inputRef?: RefObject<HTMLInputElement | null> }) {
  return (
    <div className="cl-filepick">
      <label className="cl-btn cl-btn--secondary cl-btn--md">
        {icon}
        {label}
        <input ref={inputRef} type="file" accept={accept} onChange={onFile} className="cl-sr-only" />
      </label>
      <span className="cl-filepick-hint">{hint}</span>
    </div>
  );
}

export const SourceLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="cl-source-link">
    {children}
  </a>
);

const FootLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="cl-foot-link">
    {children}
  </Link>
);

/** The section card foot strip; either side may be a link on the shared inline-link box. */
export const CardFoot = ({ left, right, leftHref, rightHref }: { left: ReactNode; right: ReactNode; leftHref?: string; rightHref?: string }) => (
  <div className="cl-card-foot">
    <span>{leftHref ? <FootLink href={leftHref}>{left}</FootLink> : left}</span>
    <span className="cl-card-foot-right">{rightHref ? <FootLink href={rightHref}>{right}</FootLink> : right}</span>
  </div>
);

interface RailCardProps {
  title: string;
  children: ReactNode;
  dataAudit?: string;
  headLink?: { label: string; href: string };
  headRight?: ReactNode;
  titleHref?: string;
  titleCount?: string;
  style?: CSSProperties;
}

/** The one rail-card shell with four head affordances: plain title, head link (a Link), head node, linked title with a count. */
export function RailCard({ title, children, dataAudit, headLink, headRight, titleHref, titleCount, style }: RailCardProps) {
  const trailing = headLink ? (
    <Link href={headLink.href} className="cl-rail-headlink">
      {headLink.label}
    </Link>
  ) : (
    (headRight ?? null)
  );
  return (
    <SectionCard dataAudit={dataAudit ?? "rail-card"} dataAttributes={{ "data-part": "rail-card" }} {...(style ? { style } : {})}>
      <div className="cl-rail-card">
        {titleHref ? (
          <div className="cl-rail-head">
            <Link href={titleHref} prefetch={false} className="cl-rail-title cl-rail-title--link">
              {title} →
            </Link>
            {titleCount && <span className="cl-rail-count">{titleCount}</span>}
          </div>
        ) : trailing ? (
          <div className="cl-rail-head cl-rail-head--split">
            <p className="cl-rail-title">{title}</p>
            {trailing}
          </div>
        ) : (
          <p className="cl-rail-title cl-rail-head">{title}</p>
        )}
        {children}
      </div>
    </SectionCard>
  );
}
