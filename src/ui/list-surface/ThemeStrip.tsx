// Ported from old_repo/src/components/shell/ThemeStripView.tsx (lines 1-135)
// Ported from old_repo/src/components/shell/ThemeStrip.tsx (lines 1-9)
import Link from "next/link";

export interface ThemeChip {
  themeId: string;
  href: string;
  label: string;
  itemTitle: string;
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
export function ThemeStrip({ chips }: { chips: ThemeChip[] }) {
  if (chips.length === 0) return null;
  return (
    <section className="cl-themes">
      <div className="cl-themes-head">
        <h2 className="cl-themes-title">Themes across the corpus</h2>
        <span className="cl-themes-count">{chips.length} active</span>
      </div>
      <div data-guard-strip role="region" aria-label="Themes across the corpus, scroll sideways for more" tabIndex={0} className="cl-themes-strip">
        {chips.map((c) => (
          <div key={c.themeId} className="cl-theme-card">
            <Link href={c.href} title={c.itemTitle} className="cl-theme-link">
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
              {c.hasBrief && <span className={`cl-theme-brief${c.stale ? " cl-theme-brief--stale" : ""}`}>{c.stale ? "Brief · out of date" : "Brief"}</span>}
            </div>
            {c.links.length > 0 && (
              <div className="cl-theme-links">
                {c.links.map((m) => (
                  <Link key={m.href} href={m.href} title={m.title} className="cl-theme-member">
                    · {m.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
