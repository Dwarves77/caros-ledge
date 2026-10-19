"use client";

// New in R2d (addendum A): the member-facing coverage ledger on the dashboard rail. It states what the source_coverage view says (collected, refused, access requested, not yet collected) and never a count of
// sources alone; a failed read is a stated failure with Retry.
import { useRouter } from "next/navigation";

import { formatDate, formatNumber } from "@/core/shared";
import { RailCard, StateNote } from "@/ui";

import { notCollected, type SourceCoverage } from "@/core/derived/source-coverage";

const sources = (n: number): string => `${formatNumber(n)} ${n === 1 ? "source" : "sources"}`;

export function CoverageLedgerCard({ coverage }: { coverage: SourceCoverage | null }) {
  const router = useRouter();
  return (
    <RailCard title="Source coverage" dataAudit="coverage-ledger-card" titleHref="/dashboard/coverage">
      {coverage === null ? (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
          Source coverage did not load.
        </StateNote>
      ) : coverage.total === 0 ? (
        <StateNote>No sources are registered yet.</StateNote>
      ) : (
        <div data-part="coverage-ledger">
          <p>
            {formatNumber(coverage.byState.collected)} of {sources(coverage.total)} collected.
          </p>
          <p>{sources(notCollected(coverage))} not yet collected.</p>
          {coverage.byState.refused > 0 && <p>{sources(coverage.byState.refused)} refused automated access.</p>}
          {coverage.byState.access_requested > 0 && <p>Access requested for {sources(coverage.byState.access_requested)}.</p>}
          {coverage.lastCaptureAt && <p>Latest capture {formatDate(coverage.lastCaptureAt.slice(0, 10))}.</p>}
        </div>
      )}
    </RailCard>
  );
}
