// Ported from old_repo/src/components/ui/FilePickRow.tsx (lines 13-57)
// Ported from old_repo/src/components/ui/SourceLink.tsx (lines 9-29)
// Ported from old_repo/src/components/ui/CardFoot.tsx (lines 40-113)
// Ported from old_repo/src/components/ui/RailCard.tsx (lines 28-132)
// Ported from old_repo/src/lib/tint.ts (lines 1-3)
import Link from "next/link";
import type { ChangeEvent, CSSProperties, ReactNode, RefObject } from "react";

import { buttonClass } from "./Button";
import { Input } from "./FormField";
import { SectionCard } from "./SectionCard";

/** A color-mix builder; kept for the admin callers that tint a token. */
export const tint = (cssVar: string, percent: number): string => `color-mix(in srgb, ${cssVar} ${percent}%, transparent)`;

export function FilePickRow({ label, hint, accept, onFile, icon, inputRef }: { label: string; hint: string; accept: string; onFile: (e: ChangeEvent<HTMLInputElement>) => void; icon?: ReactNode; inputRef?: RefObject<HTMLInputElement | null> }) {
  return (
    <div className="cl-filepick">
      <label className={buttonClass()}>
        {icon}
        {label}
        <Input bare ref={inputRef} type="file" accept={accept} onChange={onFile} className="cl-sr-only" />
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
  <Link href={href} prefetch={false} className="cl-foot-link">
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
const railThemeOf = (title: string): string => {
  const t = title.toLowerCase();
  if (t.includes("obligation") || t.includes("due") || t.includes("watchlist") || t.includes("notice")) return "obligations";
  if (t.includes("impact") || t.includes("dissent") || t.includes("gap")) return "risk";
  if (t.includes("relevance") || t.includes("horizon") || t.includes("theme") || t.includes("cluster") || t.includes("related")) return "connected";
  if (t.includes("figure") || t.includes("recalculated") || t.includes("owner")) return "operations";
  if (t.includes("source") || t.includes("signpost") || t.includes("history") || t.includes("legend")) return "sources";
  return "summary";
};

export function RailCard({ title, children, dataAudit, headLink, headRight, titleHref, titleCount, style }: RailCardProps) {
  const trailing = headLink ? (
    <Link href={headLink.href} prefetch={false} className="cl-rail-headlink">
      {headLink.label}
    </Link>
  ) : (
    (headRight ?? null)
  );
  return (
    <SectionCard dataAudit={dataAudit ?? "rail-card"} dataAttributes={{ "data-part": "rail-card", "data-rail-theme": railThemeOf(title) }} {...(style ? { style } : {})}>
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
