"use client";

// Ported from old_repo/src/components/portfolio/PortfolioIndexView.tsx (lines 52-213)
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { countNoun, formatLocaleDate } from "@/core/shared";
import { Button, CardFoot, InlineErrorBanner, Input, Masthead, RailCard, RowTable, SectionCard, SectionHead, StateNote } from "@/ui";
import { PageFrame } from "@/ui/shell";
import type { PortfolioSummary } from "@/features/workspace/portfolio/types";

import { createPortfolioRequest } from "../client";

import styles from "./portfolio.module.css";

const NAME_MAX = 80;
const cols = [
  { label: "Portfolio", width: "minmax(0, 1fr)" },
  { label: "Members", width: "88px" },
  { label: "Created", width: "120px" },
];

/** The portfolio index: a create form (members, admins and owners), the workspace's portfolios newest first, and an unavailable state with a way back when the read failed. */
export function PortfolioIndexView({ portfolios, unavailable, readOnly, dateLabel, nowIso }: { portfolios: PortfolioSummary[]; unavailable: boolean; readOnly: boolean; dateLabel: string; nowIso: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const clean = name.trim();
    if (!clean || pending) return;
    setPending(true);
    setError(null);
    const res = await createPortfolioRequest(clean);
    setPending(false);
    const id = res.body?.portfolio.id;
    if (!res.ok || !id) return setError(res.ok ? "The portfolio was created but could not be opened. Reload the page to find it." : (res.error ?? "That did not go through. Try again."));
    router.push(`/dashboard/portfolio/${id}`);
  }

  return (
    <>
      <div className="cl-list-surface-masthead">
        <Masthead title="Portfolios" dateLabel={dateLabel} nowIso={nowIso} dek="A portfolio is a selection of items, corridors and entities your workspace holds together. It filters nothing and analyses nothing you type; the figures shown for it come from held data only." />
      </div>
      <PageFrame
        rail={
          <RailCard title="How portfolios work">
            <p className={styles.say}>Add an item, corridor or entity from the page that shows it. Adding the same thing again from anywhere is the same record. Everyone in your workspace sees the same portfolios; members, admins and owners can change them.</p>
          </RailCard>
        }
      >
        <div className={styles.column}>
          <SectionCard>
            <SectionHead title={unavailable ? "Portfolios" : `Portfolios · ${portfolios.length}`} aside="Newest first" />
            {unavailable ? (
              <div className="cl-pad-16">
                <StateNote tone="error" action={{ label: "Try again", onClick: () => router.refresh() }}>
                  Portfolios could not be read just now. Nothing was lost; try again in a moment.
                </StateNote>
              </div>
            ) : (
              <>
                {!readOnly && (
                  <form className={styles.form} onSubmit={(e) => (e.preventDefault(), void create())}>
                    <Input id="portfolio-name" className={styles.grow} aria-label="Portfolio name" value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} placeholder="Name a new portfolio, for example Asia to Europe lanes" autoComplete="off" />
                    <Button type="submit" variant="primary" disabled={pending || name.trim().length === 0}>
                      {pending ? "Creating..." : "Create portfolio"}
                    </Button>
                  </form>
                )}
                {error && (
                  <div className={styles.padSm}>
                    <InlineErrorBanner message={error} />
                  </div>
                )}
                {portfolios.length === 0 ? (
                  <div className={styles.pad}>
                    <StateNote>{readOnly ? "No portfolios yet. Your role in this workspace can read portfolios but not create them; a member, admin or owner can." : "No portfolios yet. Name one above to start; it opens straight away and you can add items, corridors and entities from there."}</StateNote>
                  </div>
                ) : (
                  <RowTable
                    columns={cols}
                    rows={portfolios.map((p) => ({
                      key: p.id,
                      cells: [
                        <Link key="n" href={`/dashboard/portfolio/${p.id}`} className={styles.nameLink}>
                          <span data-guard-title className={styles.title}>
                            {p.name}
                          </span>
                        </Link>,
                        <span key="m" className={styles.muted}>
                          {countNoun(p.memberCount, "member")}
                        </span>,
                        <span key="c" className={styles.muted}>
                          {formatLocaleDate(new Date(p.createdAt), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                        </span>,
                      ],
                    }))}
                  />
                )}
                <CardFoot left="Open a portfolio to see its roll-ups." right={null} />
              </>
            )}
          </SectionCard>
        </div>
      </PageFrame>
    </>
  );
}
