"use client";

// Ported from old_repo/src/components/figures/RecalculationNotice.tsx (lines 20-131)
// Ported from old_repo/src/components/figures/NoticesRail.tsx (lines 28-133)
// Recalculation notices: "a figure you may have seen has just changed, and why". The hook reads GET /api/notices and answers loading, ready or FAILED (a failed read is a note with Retry, never "no recalculations": an outage must not read
// as nothing having changed). The copy names no table, key or method in the open; the method versions sit in a closed disclosure.
import { useCallback, useEffect, useState } from "react";

import { formatDate, formatNumber } from "@/core/shared";
import { requestJson } from "@/core/http/request-json";
import type { SupersededNotice } from "@/core/propagation";

import { SectionCard } from "../SectionCard";
import { StateNote } from "../StateNote";

import styles from "./figures.module.css";

export interface RecalculationNoticeItem extends SupersededNotice {
  /** The entity's name when it resolved; the notice never shows an id. */
  entityLabel?: string | null;
}
export type NoticesState = { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; notices: RecalculationNoticeItem[]; since: string | null };

/** The feed behind every notices surface (this rail, the watchlist): one call, a distinct failed state, a Retry. */
function useRecalculationNotices(request = requestJson): NoticesState & { retry: () => void } {
  const [state, setState] = useState<NoticesState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    request<{ notices?: RecalculationNoticeItem[]; since?: string }>("/api/notices").then((r) => {
      if (cancelled) return;
      if (!r.ok || !Array.isArray(r.data?.notices)) setState({ status: "failed", error: r.error ?? "The notices came back in a form this page cannot read." });
      else setState({ status: "ready", notices: r.data.notices, since: typeof r.data.since === "string" ? r.data.since : null });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, request]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, retry };
}

const num = (n: number | null): string => (n === null || !Number.isFinite(n) ? "—" : formatNumber(n, { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }));
const change = (n: SupersededNotice): string => {
  const prefix = n.currency ? `${n.currency} ` : "";
  const suffix = n.currency ? "" : n.unit ? ` ${n.unit}` : "";
  return `${prefix}${num(n.oldValue)}${suffix} → ${prefix}${num(n.newValue)}${suffix}`;
};

function NoticeRow({ n }: { n: RecalculationNoticeItem }) {
  return (
    <li className={styles.notice}>
      <div className={styles.noticeHead}>
        <span data-guard-title className={styles.noticeTitle}>
          {n.entityLabel || "A tracked figure"}
        </span>
        <span className={styles.meta}>{formatDate(n.supersededAt)}</span>
      </div>
      <p className={styles.noticeDelta}>{change(n)}</p>
      <details>
        <summary className="cl-source-link">How this was recalculated</summary>
        <p className={styles.meta}>
          {n.oldMethodVersion === n.newMethodVersion ? `Recomputed from changed inputs (${n.methodId} ${n.newMethodVersion}).` : `${n.methodId} ${n.oldMethodVersion} → ${n.newMethodVersion}.`}
        </p>
      </details>
    </li>
  );
}

/** The notices as a list, or the honest empty line. */
function RecalculationNotice({ notices, emptyMessage = "No recalculations in this window." }: { notices: RecalculationNoticeItem[]; emptyMessage?: string }) {
  if (notices.length === 0) {
    return (
      <p className={`cl-absence ${styles.empty}`} data-figure-kind="recalculation-notice-empty">
        {emptyMessage}
      </p>
    );
  }
  return (
    <ul className={styles.list} data-figure-kind="recalculation-notice-list">
      {notices.map((n) => (
        <NoticeRow key={n.newValueId} n={n} />
      ))}
    </ul>
  );
}

/** The rail every surface that shows recalculations mounts: the feed is the organisation's watchlist window, the same wherever it appears. */
export function NoticesRail({ heading = "Recalculation notices", emptyMessage = "No recalculations on your team's watchlist in this window." }: { heading?: string; emptyMessage?: string }) {
  const feed = useRecalculationNotices();
  return (
    <SectionCard as="section" padding="14px 16px" aria-label={heading} dataAttributes={{ "data-notices-rail": "" }}>
      <div className="cl-section-label">{heading}</div>
      {feed.status === "loading" ? (
        <p className={styles.meta}>Loading…</p>
      ) : feed.status === "failed" ? (
        <StateNote tone="error" action={{ label: "Retry", onClick: feed.retry }}>
          Recalculation notices did not load. {feed.error}
        </StateNote>
      ) : (
        <RecalculationNotice notices={feed.notices} emptyMessage={emptyMessage} />
      )}
    </SectionCard>
  );
}
