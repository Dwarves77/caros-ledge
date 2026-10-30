// Ported from old_repo/src/components/list-surface/ListSurfaceRailCards.tsx (lines 280-352)
// Ported from old_repo/src/components/coverage/CoverageDenominatorLineView.tsx (lines 1-66)
// The two reads-on-the-server pieces of the Regulations list: the "Obligations, next 30 days" rail card (the events arrive read; a failed read is a note, not an empty card) and the coverage line under
// the list. Both are presentational: the page reads on the caller's client and passes what it got.
import Link from "next/link";

import { formatDenominatorLine } from "@/core/coverage";
import type { DenominatorLine } from "@/core/coverage/matrix";
import { classifyByDays } from "@/core/lists";
import { daysFrom, formatForwardEventCompact, selectObligationRailRows } from "@/features/obligations";
import { Absence, CoverageState, RailCard, StateNote } from "@/ui";

import { coverageLineModel } from "./coverage-line";

export interface RailEvent {
  id: string;
  event_date: string;
  date_precision: string;
  obligation_text: string;
  item: { title: string | null };
}

export function ObligationsRailCard({ events, failed, nowIso }: { events: readonly RailEvent[]; failed: boolean; nowIso: string }) {
  const now = new Date(nowIso);
  const rows = selectObligationRailRows(events, now);
  return (
    <RailCard title="Obligations · next 30 days" dataAudit="obligations-rail" headLink={{ label: "Calendar →", href: "/regulations/register" }}>
      {failed ? (
        <StateNote tone="error">The upcoming obligations did not load. Reload the page to try again.</StateNote>
      ) : rows.length === 0 ? (
        <StateNote>Nothing is due in the next 30 days.</StateNote>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)", fontSize: "var(--fs-12)" }}>
          {rows.map((ev) => (
            <div key={ev.id} data-audit="obligation-row" style={{ display: "grid", gridTemplateColumns: "0.1875rem 3.5rem 1fr", gap: "var(--sp-10)", alignItems: "start" }}>
              <span aria-hidden="true" style={{ background: classifyByDays(daysFrom(ev.event_date, now)).cssVar, borderRadius: "0.125rem", alignSelf: "stretch" }} />
              <span style={{ fontWeight: 700, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{formatForwardEventCompact(ev.event_date, ev.date_precision)}</span>
              <span style={{ lineHeight: 1.4, color: "var(--ink)" }}>
                {ev.item.title ? `${ev.item.title} — ` : ""}{ev.obligation_text}
              </span>
            </div>
          ))}
        </div>
      )}
    </RailCard>
  );
}

/**
 * The coverage line under the list: numerator beside denominator and the verified-brief count, and ALWAYS the way to the cell. When the count could not be read (the read failed, or the database
 * does not yet carry the object it needs) the count is the Absence token with a stated note and the link is still drawn; a surface with nothing catalogued says so.
 */
export function CoverageLine({ denominator, failed, surface }: { denominator: DenominatorLine | null; failed: boolean; surface: string }) {
  const { href, state } = coverageLineModel(denominator, failed, surface);
  const unavailable = state === "unavailable";
  return (
    <div data-guard-container="coverage-denominator" style={{ padding: "var(--sp-14) 0 0" }}>
      {state === "empty-catalogue" && denominator ? (
        <CoverageState state="not_covered" variant="inline" subject={`The ${denominator.label} catalogue`} reason="No instrument has been catalogued for this surface yet." requestRef={denominator.href} />
      ) : null}
      <p data-part="coverage-denominator" style={{ margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0 var(--sp-12)", fontSize: "var(--fs-11)", color: "var(--ink-2)" }}>
        {unavailable ? (
          <span role="alert" data-part="state-note" style={{ overflowWrap: "anywhere" }}>
            Coverage count: <Absence reason="connect data" variant="dash" /> It did not load; the coverage page has the full count.
          </span>
        ) : (
          <span style={{ overflowWrap: "anywhere" }}>{denominator ? formatDenominatorLine(denominator) : null}</span>
        )}
        <Link href={href} prefetch={false} className="cl-rail-link">
          See coverage
        </Link>
      </p>
    </div>
  );
}
