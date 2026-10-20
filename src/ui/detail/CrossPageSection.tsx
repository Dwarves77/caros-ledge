// Ported from old_repo/src/components/detail/CrossPageSection.tsx (lines 1-47)
// Ported from old_repo/src/lib/research/theme-brief-text.mjs (lines 1-47)
import Link from "next/link";
import type { ReactNode } from "react";

import { pickVisibleInferences, type InferenceView } from "@/core/detail/inference-view";
import { CONNECTED_SECTION_ID, crossPageOrd, INFERENCES_SECTION_ID } from "@/core/detail/section-index";
import type { buildIntersectionView } from "@/core/flywheel/view-model";
import type { ThemeAnalysisView } from "@/core/themes";

import { GfmSection } from "../GfmSection";
import { DetailSubSection } from "../ItemGroup";
import { StateNote } from "../StateNote";

import { DetailSection } from "./DetailShell";
import { admissibleForDisplay, InferenceSection } from "./InferenceSection";

export interface CrossPageData {
  /** The intersection view, computed once by the loader from the item's connections (this part imports no server module). */
  intersections?: IntersectionView | null;
  theme?: ThemeAnalysisView | null;
  inferences?: InferenceView | null;
  /** The blocks whose read failed this request: the section says so and the page offers Retry. */
  degraded?: string[];
}
export type IntersectionView = NonNullable<ReturnType<typeof buildIntersectionView>>;
type Group = IntersectionView["groups"][number];

/**
 * The statistics and weights a pre-contract theme brief carried in its prose are not a customer's to read; the structured sections never carry them. Only a number the prose labels (density, a dominant
 * signal weight, "scores") is removed: a bare 0.xxx or 1.xxx is a figure the brief states (1.250 EUR, 0.875 kg) and is left alone (I7, the scrubber deleted it).
 */
export function cleanPreContractBriefText(md: string): string {
  const num = String.raw`\d+(?:\.\d+)?`;
  return md
    .replace(new RegExp(String.raw`^[ \t]*\*\*\d+ members?\b[^\n]*?density ${num}\*\*[ \t]*\r?\n?`, "gim"), "")
    .replace(new RegExp(String.raw`[ \t]*\(?\s*(?:dominant signal weight|density) ${num}\s*\)?`, "gi"), "")
    .replace(/[ \t]+scores[ \t]+[01]\.\d{3}\b/gi, "")
    .replace(/[ \t]+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const Label = ({ children }: { children: ReactNode }) => <p className="cl-detail-label">{children}</p>;
const Block = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="cl-detail-block">
    <Label>{label}</Label>
    {children}
  </div>
);
const RowLink = ({ href, title, note }: { href: string; title: string; note?: string | undefined }) => (
  <Link href={href} prefetch={false} className="cl-detail-link">
    <p data-guard-title className="cl-detail-link-title">
      {title}
    </p>
    {note && <p className="cl-detail-link-note">{note}</p>}
  </Link>
);

function GroupList({ groups }: { groups: Group[] }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.surface} className="cl-detail-block">
          <Label>
            {g.label}
            {g.samePage ? " (this page)" : ""} · {g.items.length}
          </Label>
          {g.items.map((it) => (
            <RowLink key={it.id} href={it.href} title={it.title} note={it.coupling} />
          ))}
        </div>
      ))}
    </>
  );
}

function ThemeAnalysis({ theme, surfaceLabel, first }: { theme: ThemeAnalysisView; surfaceLabel: string; first: boolean }) {
  const pageNames = theme.pages.map((p) => p.label).join(", ");
  const s = theme.sections;
  const staleNote = theme.supersedesThemeId ? "Stale: this synthesis was written for an earlier version of this theme and its membership has changed since." : "Stale: this theme's membership has changed since the synthesis was written.";
  return (
    <DetailSubSection title="Theme analysis" subtitle={`${theme.memberCount} ${theme.memberCount === 1 ? "item" : "items"}${pageNames ? ` across ${pageNames}` : ""}`} first={first}>
      {theme.hasBrief && theme.title && (
        <p data-guard-title className="cl-detail-link-title" style={{ fontWeight: 600 }}>
          {s ? theme.title : cleanPreContractBriefText(theme.title)}
        </p>
      )}
      {theme.hasBrief && theme.stale && (
        <div className="cl-detail-block">
          <StateNote>{staleNote}</StateNote>
        </div>
      )}
      {s ? (
        <>
          {s.meaning && (
            <Block label="What it means">
              <GfmSection markdown={s.meaning} />
            </Block>
          )}
          {s.forThisPage ? (
            <Block label={`What follows on ${surfaceLabel}`}>
              <GfmSection markdown={s.forThisPage} />
            </Block>
          ) : (
            theme.ramificationsMissing && (
              <Block label={`What follows on ${surfaceLabel}`}>
                <p style={{ fontSize: "var(--fs-12)", color: "var(--ink-2)", margin: 0 }}>This brief has no ramifications written for {surfaceLabel}. A new brief for this theme will add them.</p>
              </Block>
            )
          )}
          {s.watch && (
            <Block label="What to watch">
              <GfmSection markdown={s.watch} />
            </Block>
          )}
        </>
      ) : theme.hasBrief && theme.briefMd ? (
        <div className="cl-detail-block">
          <GfmSection markdown={cleanPreContractBriefText(theme.briefMd)} />
        </div>
      ) : null}
      {!theme.hasBrief && theme.absence && (
        <div className="cl-detail-block">
          <StateNote>{theme.absence}</StateNote>
        </div>
      )}
      {theme.membersByPage.length > 0 && (
        <Block label="Other items in this theme">
          {theme.membersByPage.map((g) => (
            <div key={g.surface} className="cl-detail-block">
              <Label>
                {g.label}
                {g.samePage ? " (this page)" : ""} · {g.total}
              </Label>
              {g.items.map((it) => (
                <RowLink key={it.id} href={it.href} title={it.title} />
              ))}
              {g.moreHref && <RowLink href={g.moreHref} title={`and ${g.total - g.items.length} more on ${g.label}`} />}
            </div>
          ))}
        </Block>
      )}
      {s && (s.connection || s.gaps) && (
        <details data-audit="disclosure-row" className="cl-detail-disclosure">
          <summary>How the items connect{s.gaps ? " and what is missing" : ""}</summary>
          {s.connection && (
            <Block label="How the items connect">
              <GfmSection markdown={s.connection} />
            </Block>
          )}
          {s.gaps && (
            <Block label="What is missing">
              <GfmSection markdown={s.gaps} />
            </Block>
          )}
        </details>
      )}
    </DetailSubSection>
  );
}

/** Which of the two cross-page sections this item has (the section index lists only those). */
export function crossPagePresence(crossPage?: CrossPageData | null): { connected: boolean; inferences: boolean } {
  return { connected: !!crossPage?.intersections || !!crossPage?.theme || (crossPage?.degraded?.includes("themes") ?? false), inferences: (crossPage?.degraded?.includes("inferences") ?? false) || pickVisibleInferences(crossPage?.inferences?.claims ?? [], admissibleForDisplay).length > 0 };
}

/** "Connected intelligence" (intersections and the theme analysis) and the Inferences section; the view is computed once here from the rows the page read. */
export function CrossPageSection({ surfaceKey, surfaceLabel, crossPage, onRetry }: { surfaceKey: string; surfaceLabel: string; crossPage?: CrossPageData | null; onRetry?: () => void }) {
  const view = crossPage?.intersections ?? null;
  const theme = crossPage?.theme ?? null;
  const themesFailed = crossPage?.degraded?.includes("themes") ?? false;
  const inferences = <InferenceSection inferences={crossPage?.inferences} index={crossPageOrd(surfaceKey, INFERENCES_SECTION_ID)} failed={crossPage?.degraded?.includes("inferences") ?? false} onRetry={onRetry} />;
  if (!view && !theme && !themesFailed) return inferences;
  return (
    <>
      <DetailSection id={CONNECTED_SECTION_ID} title="Connected intelligence" aside="Intersections and theme analysis" index={crossPageOrd(surfaceKey, CONNECTED_SECTION_ID)}>
        <div data-guard-container="cross-page">
          {view && (
            <DetailSubSection title="Intersections" subtitle="Items that share an operational scenario and a compliance object with this one" first>
              {view.summary && (
                <div>
                  <Label>Stated coupling</Label>
                  <GfmSection markdown={view.summary} />
                </div>
              )}
              <GroupList groups={view.groups} />
              {view.possible.length > 0 && (
                <details data-audit="disclosure-row" className="cl-detail-disclosure">
                  <summary>Possible connections ({view.possibleCount})</summary>
                  <p className="cl-detail-link-note">Weaker overlaps, kept apart from the connections above.</p>
                  <GroupList groups={view.possible} />
                </details>
              )}
            </DetailSubSection>
          )}
          {theme && <ThemeAnalysis theme={theme} surfaceLabel={surfaceLabel} first={!view} />}
          {themesFailed && (
            <div className="cl-detail-block">
              <StateNote tone="error" {...(onRetry ? { action: { label: "Retry", onClick: onRetry } } : {})}>
                The theme analysis did not load.
              </StateNote>
            </div>
          )}
        </div>
      </DetailSection>
      {inferences}
    </>
  );
}
