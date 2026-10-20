"use client";

// Ported from old_repo/src/components/ui/SectionIndex.tsx (lines 28-136)
// Ported from old_repo/src/components/ui/SectionIndexLink.tsx (lines 12-39)
// Ported from old_repo/src/components/ui/section-index-styles.ts (lines 1-54)
// Ported from old_repo/src/lib/detail/use-section-scroll-spy.ts (lines 1-40)
import { useEffect, useState } from "react";

export interface SectionIndexEntry {
  id: string;
  shortName: string;
  ord?: number;
}
export type SectionIndexDepth = "summary" | "full";

/** The index of the section nearest the top of the viewport (the first one when none intersects). */
function useSectionScrollSpy(ids: string[]): number {
  const [active, setActive] = useState(0);
  const key = ids.join("|");
  useEffect(() => {
    const els = key.split("|").map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const idx = first ? els.indexOf(first.target as HTMLElement) : -1;
        if (idx >= 0) setActive(idx);
      },
      { rootMargin: "-64px 0px -70% 0px", threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]);
  return active;
}

/** The Summary | Full brief switch, inside the index bar so it sits at the same position on every detail page. */
function SummaryDepthSwitch({ depth, onChange }: { depth: SectionIndexDepth; onChange: (d: SectionIndexDepth) => void }) {
  const opt = (value: SectionIndexDepth, label: string) => (
    <button key={value} type="button" aria-pressed={depth === value} onClick={() => onChange(value)} className="cl-depth-opt">
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Summary depth" className="cl-depth-switch">
      {opt("summary", "Summary")}
      {opt("full", "Full brief")}
    </div>
  );
}

/** The detail section index bar: scroll-spy tabs that never truncate, the depth switch inside the same bordered card. */
export function SectionIndex({ sections, depth, onDepthChange }: { sections: SectionIndexEntry[]; depth?: SectionIndexDepth; onDepthChange?: (d: SectionIndexDepth) => void }) {
  const active = useSectionScrollSpy(sections.map((s) => s.id));
  if (sections.length === 0) return null;
  return (
    <nav aria-label="Section index" data-part="section-index" className="cl-section-index">
      <div data-guard-strip className="cl-section-index-strip">
        <div data-guard-strip className="cl-section-index-tabs">
          {sections.map((s, i) => (
            <a key={s.id} href={`#${s.id}`} className="cl-section-index-link" aria-current={i === active ? "true" : undefined}>
              S{s.ord ?? i + 1} {s.shortName}
            </a>
          ))}
        </div>
        {depth && onDepthChange && (
          <div className="cl-section-index-depth">
            <SummaryDepthSwitch depth={depth} onChange={onDepthChange} />
          </div>
        )}
      </div>
    </nav>
  );
}
