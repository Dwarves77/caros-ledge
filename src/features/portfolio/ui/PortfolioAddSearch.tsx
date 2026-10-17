"use client";

// Ported from old_repo/src/components/portfolio/PortfolioAddSearch.tsx (lines 55-223)
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { coverageHref, surfaceDenominator } from "@/core/coverage";
import { formatPortfolioCoverageLine } from "@/core/coverage/matrix";
import { authedFetch } from "@/core/http/authed-fetch";
import { surfaceOf } from "@/core/routing";
import { Button, CoverageState, InlineErrorBanner, Input, StateNote } from "@/ui";
import { useItemSearch } from "@/features/search/use-item-search";
import type { SearchRow } from "@/features/search/types";

import { addMemberRequest } from "../client";

import styles from "./portfolio.module.css";

interface CoverageClass {
  code: string;
  label: string;
  numerator: number;
  denominator: number;
}
type CoverageRead = { phase: "idle" | "failed"; classes: null } | { phase: "ready"; classes: CoverageClass[] };
/** The census class a surface's items are counted in. */
const CENSUS_CLASS: Record<string, string> = { regulations: "regulations", operations: "operations", research: "research", market: "market_intel" };

async function readCoverage(): Promise<CoverageRead> {
  try {
    const res = await authedFetch("/api/dashboard/coverage/matrix?summary=1");
    const body = res.ok ? ((await res.json()) as { dataClasses?: CoverageClass[] }) : null;
    return body?.dataClasses ? { phase: "ready", classes: body.dataClasses } : { phase: "failed", classes: null };
  } catch {
    return { phase: "failed", classes: null };
  }
}

/** Coverage at the moment of commitment (COV-1): the catalogue cell the thing being added sits in, so the reader's expectations are set before they add it. */
function CoverageLine({ hit, classes }: { hit: SearchRow; classes: CoverageClass[] }) {
  const code = CENSUS_CLASS[surfaceOf(hit.item_type, hit.domain)];
  if (!code) return <div className={styles.cover}>Coverage for this: <CoverageState state="not_applicable" variant="cell" subject="Coverage for this item" reason="No discovery census covers this kind of item." /></div>;
  const cls = classes.find((c) => c.code === code);
  const line = cls && cls.denominator > 0 ? surfaceDenominator(code, { total: cls.denominator, dualVerified: cls.numerator }) : null;
  if (!line) return <div className={styles.cover}><CoverageState state="not_covered" variant="inline" subject="Catalogue coverage for this" requestRef={coverageHref({ dataClass: code })} /></div>;
  return (
    <div className={styles.cover}>
      <span>{formatPortfolioCoverageLine(line)}</span>
      <Link href={coverageHref({ dataClass: code })} className={styles.coverLink}>
        See coverage
      </Link>
    </div>
  );
}

/** Add by search: Standard Search over held items, an "In portfolio" state, and a coverage line per result. It analyses nothing the reader types (ADR-042). */
export function PortfolioAddSearch({ portfolioId, memberItemIds }: { portfolioId: string; memberItemIds: string[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { hits, searching, failed, retry } = useItemSearch(query);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<CoverageRead>({ phase: "idle", classes: null });
  const wantCoverage = hits.length > 0 && coverage.phase === "idle";
  useEffect(() => {
    if (!wantCoverage) return;
    let live = true;
    void readCoverage().then((next) => live && setCoverage(next));
    return () => {
      live = false;
    };
  }, [wantCoverage]);

  const already = new Set([...memberItemIds, ...added]);
  async function add(hit: SearchRow) {
    if (pendingId) return;
    setPendingId(hit.id);
    setError(null);
    const res = await addMemberRequest(portfolioId, { itemId: hit.id });
    setPendingId(null);
    if (!res.ok) return setError(res.error ?? "That did not go through. Try again.");
    setAdded((prev) => new Set(prev).add(hit.id));
    router.refresh();
  }

  return (
    <div className={styles.pad}>
      <Input id="portfolio-add-search" aria-label="Search for an item to add" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the platform for an item to add" autoComplete="off" />
      {error && (
        <div className={styles.status}>
          <InlineErrorBanner message={error} />
        </div>
      )}
      {searching && <p className={styles.status}>Searching...</p>}
      {failed && (
        <div className={styles.status}>
          <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
            Search is not available right now. Try again in a moment.
          </StateNote>
        </div>
      )}
      {!searching && !failed && query.trim().length >= 2 && hits.length === 0 && (
        <div className={styles.status}>
          <StateNote>The platform holds nothing matching that search. Try a different word.</StateNote>
        </div>
      )}
      {hits.length > 0 && coverage.phase === "failed" && (
        <div className={styles.status}>
          <CoverageState state="error" variant="inline" subject="The coverage for these results" onRetry={() => setCoverage({ phase: "idle", classes: null })} />
        </div>
      )}
      {hits.length > 0 && (
        <ul className={styles.hits}>
          {hits.map((hit) => {
            const isIn = already.has(hit.id);
            return (
              <li key={hit.id} className={styles.hit}>
                <div className={styles.hitText}>
                  {hit.title}
                  {coverage.phase === "ready" && <CoverageLine hit={hit} classes={coverage.classes} />}
                </div>
                <Button className={styles.hitBtn} variant={isIn ? "ghost" : "secondary"} disabled={isIn || pendingId !== null} onClick={() => void add(hit)} aria-label={isIn ? `${hit.title} is in this portfolio` : `Add ${hit.title} to this portfolio`}>
                  {isIn ? "In portfolio" : pendingId === hit.id ? "Adding..." : "Add"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
