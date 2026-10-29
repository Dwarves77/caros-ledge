"use client";

// Ported from old_repo/src/components/market/MarketPolicyTimeline.tsx (lines 21-37)
// Ported from old_repo/src/components/regulations/UpcomingObligationsStrip.tsx (lines 35-143)
// Ported from old_repo/src/components/regulations/UpcomingObligationsStripView.tsx (lines 1-82)
// Ported from old_repo/src/components/regulations/UpcomingObligationsStripView.tsx (lines 144-313)
// The Market policy timeline (spec 02 row 9): dated, forward-looking obligations for the modes and regions IN SCOPE: the ledger's mode and region facets when set, else the workspace profile (the route resolves that). The scope is shown
// as text with "N hidden by your scope" and the one control that widens it. A failed read is a note with Retry, never "no upcoming obligations": an outage must not read as nothing due.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { formatNumber } from "@/core/shared";
import { KIND_LABELS } from "@/features/obligations/kinds";
import { formatForwardEvent } from "@/features/obligations/read/rail-select";
import { Button } from "@/ui/Button";
import { parseListUrl } from "@/ui/list-surface/url-state";
import { SectionCard } from "@/ui/SectionCard";
import { SectionHead } from "@/ui/SectionHead";
import { StateNote } from "@/ui/StateNote";

import styles from "./market.module.css";

interface UpcomingEvent {
  id: string;
  event_date: string;
  date_precision: string;
  event_kind: string;
  obligation_text: string;
  item: { id: string; title: string | null; legacy_id: string | null; jurisdiction_iso: string[] | null };
}
interface Upcoming {
  events: UpcomingEvent[];
  hasJurisdictionFilter: boolean;
  scope?: { label: string };
  hiddenByScope?: number;
}
type Feed = { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; data: Upcoming };

function EventCard({ ev }: { ev: UpcomingEvent }) {
  const jurisdiction = ev.item.jurisdiction_iso?.[0] ?? null;
  return (
    <Link href={`/regulations/${encodeURIComponent(ev.item.legacy_id || ev.item.id)}`} data-guard-container="upcoming-event-card" className={styles.event}>
      <span className={styles.eventHead}>
        <span className={styles.eventKind}>{KIND_LABELS[ev.event_kind as keyof typeof KIND_LABELS] ?? ev.event_kind}</span>
        <span className={styles.eventDate}>{formatForwardEvent(ev.event_date, ev.date_precision)}</span>
      </span>
      <span data-guard-title className={styles.eventTitle}>
        {ev.item.title}
        {jurisdiction && <span className={styles.eventJuris}>{jurisdiction}</span>}
      </span>
      <span className={styles.eventText}>{ev.obligation_text}</span>
    </Link>
  );
}

export function PolicyTimeline() {
  const filter = parseListUrl(useSearchParams()).filter;
  const [widened, setWidened] = useState(false);
  const [feed, setFeed] = useState<Feed>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const { mode, region } = filter;
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ scope: widened ? "all" : "1" });
    if (!widened && mode) params.set("modes", mode);
    if (!widened && region) params.set("regions", region);
    requestJson<Upcoming>(`/api/obligations/upcoming?${params}`).then((r) => {
      if (cancelled) return;
      setFeed(r.ok && r.data && Array.isArray(r.data.events) ? { status: "ready", data: r.data } : { status: "failed", error: r.error ?? "The obligations came back in a form this page cannot read." });
    });
    return () => {
      cancelled = true;
    };
  }, [widened, mode, region, attempt]);
  const retry = useCallback(() => {
    setFeed({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const data = feed.status === "ready" ? feed.data : null;
  const hidden = data?.hiddenByScope ?? 0;
  return (
    <div className={styles.band}>
      <SectionCard as="section" dataAudit="policy-timeline" dataAttributes={{ "data-sec-theme": "obligations" }}>
        <SectionHead title="Upcoming obligations" aside={data && data.events.length > 0 ? `${formatNumber(data.events.length)} ${data.events.length === 1 ? "event" : "events"}` : "Policy timeline"} />
        <p className="cl-detail-section-explainer-bar">Dated, forward-looking obligations for the modes and regions in scope: the filters you set above, otherwise your workspace&apos;s own modes and jurisdictions.</p>
        <div className={styles.cardBody}>
          {feed.status === "loading" && <p className={styles.muted}>Loading upcoming obligations…</p>}
          {feed.status === "failed" && <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>Upcoming obligations did not load. {feed.error}</StateNote>}
          {data && (
            <>
              <div data-audit="policy-scope" className={styles.scopeLine}>
                <span className={styles.muted}>Scope: <b data-audit="policy-scope-label">{widened ? "All modes and regions" : data.scope?.label || "All modes and regions"}</b></span>
                {!widened && hidden > 0 && <Button size="sm" data-audit="policy-scope-widen" onClick={() => setWidened(true)}>{formatNumber(hidden)} hidden by your scope · Show all</Button>}
                {widened && <Button size="sm" data-audit="policy-scope-narrow" onClick={() => setWidened(false)}>Back to your scope</Button>}
              </div>
              {data.events.length === 0 ? (
                <p className={styles.muted}>No upcoming obligations match {widened ? "any scope" : data.scope?.label || (data.hasJurisdictionFilter ? "your workspace's jurisdictions" : "this scope")} right now.</p>
              ) : (
                <div data-guard-strip className={`cl-scroll-shadow ${styles.eventStrip}`}>
                  {data.events.map((ev) => <EventCard key={ev.id} ev={ev} />)}
                </div>
              )}
            </>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
