// Ported from old_repo/src/components/shell/ThemeStripView.tsx (lines 1-135)
// Ported from old_repo/src/components/shell/ThemeStrip.tsx (lines 1-9)
import Link from "next/link";

import { FlywheelRadar, type RadarView } from "../flywheel/FlywheelRadar";

export interface ThemeChip {
  themeId: string;
  href: string;
  label: string;
  itemTitle: string; meaning?: string | null;
  /** What the theme's edges are mostly about, by name (up to three); empty when none is known. */
  linkedBy?: string[];
  memberCount: number;
  pages: Array<{ surface: string; label: string }>;
  hasBrief: boolean;
  stale: boolean;
  links: Array<{ title: string; href: string }>;
}

/**
 * The strip of theme cards on a list page. The chips arrive built (the research surface owns theme-brief resolution and the bounded reader); an empty
 * list renders nothing: an honest omission, there is no strip when no live theme touches the page.
 */
export function ThemeStrip({ chips, radar }: { chips: ThemeChip[]; radar?: RadarView | null | undefined }) {
  // `radar` undefined: the page read none (a fixture); null: its read failed; otherwise the cross-surface patterns of this page, drawn under the themes
  const panel = radar === undefined ? null : <FlywheelRadar view={radar} />;
  if (chips.length === 0) return panel;
  return (
    <>
    <section className="cl-themes">
      <div className="cl-themes-head">
        <h2 className="cl-themes-title">Themes across the corpus</h2>
        <span className="cl-themes-count">{chips.length} active</span>
      </div>
      <div data-guard-strip role="region" aria-label="Themes across the corpus, scroll sideways for more" tabIndex={0} className="cl-themes-strip">
        {chips.map((c) => (
          <div key={c.themeId} className="cl-theme-card">
            <Link href={c.href} prefetch={false} title={c.itemTitle} className="cl-theme-link">
              <span data-guard-title className="cl-theme-label">
                {c.label}
              </span>
            </Link>
            <div className="cl-theme-meta">
              <span className="cl-theme-items">
                {c.memberCount} {c.memberCount === 1 ? "item" : "items"}
              </span>
              {c.pages.map((p) => (
                <span key={p.surface} className="cl-theme-page">
                  {p.label}
                </span>
              ))}
              {c.hasBrief && <span className={`cl-theme-brief${c.stale ? " cl-theme-brief--stale" : ""}`}>{c.stale ? "Written for an earlier membership" : "Brief"}</span>}
            </div>
            {c.hasBrief && !!c.linkedBy?.length && <p className="cl-detail-link-note">Linked by {c.linkedBy.join(", ")}</p>}
            {c.meaning && <p className="cl-detail-link-note">{c.meaning}</p>}
            {c.links.length > 0 && (
              <div className="cl-theme-links">
                {c.links.map((m) => (
                  <Link key={m.href} href={m.href} prefetch={false} title={m.title} className="cl-theme-member">
                    · {m.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
    {panel}
    </>
  );
}
