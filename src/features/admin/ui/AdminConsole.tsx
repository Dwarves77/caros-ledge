"use client";

// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 136-194)
// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 196-311)
// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 348-426)
// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 432-597)
// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 626-726)
import Link from "next/link";
import { useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { SourceRegistryCard, type RegistryView } from "@/features/sources-admin/ui/SourceRegistryCard";
import { Button, Masthead, RailCard, StatBlock, TabRow } from "@/ui";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { refreshBootstrap, useBootstrapStore } from "@/ui/shell/use-bootstrap";

import type { AttentionCounts } from "../api/attention";
import { CorrectionsTab } from "../corrections/CorrectionsTab";
import type { DashboardData, Part } from "../read/dashboard";
import type { AdminProvisional, AdminSource } from "../read/sources";

import { BulkImportView } from "./BulkImportView";
import { CoverageCatalogueView } from "./CoverageCatalogueView";
import { CoverageMatrixView } from "./CoverageMatrixView";
import { SECTIONS, subTabCount, tileCount, type IssueNavTarget, type SectionDef } from "./console-math";
import { DispatchPanel } from "./DispatchPanel";
import { FlagsQueue } from "./FlagsQueue";
import { IssueFilterCaption, issueFilterLabel } from "./IssueFilterCaption";
import { IssuesRail } from "./IssuesRail";
import { JurisdictionReviewView } from "./JurisdictionReviewView";
import { PartFailure } from "./panel-kit";
import { ResearchPipelineView } from "./ResearchPipelineView";
import { AdminEventsView, AssumptionRegisterView, ErrorGroupsView, InferencesView } from "./RuntimeViews";
import { StagedTransitView } from "./StagedTransitView";
import { StatutoryRowsUpload } from "./StatutoryRowsUpload";
import { TierDisagreementsView } from "./TierDisagreementsView";
import { UsageCard, WorkspacesOverview } from "./WorkspacesOverview";
import styles from "./admin.module.css";

const ok = <T,>(p: Part<T>): T | null => (p.ok ? p.data : null);

/**
 * The operator surface: six sections with live counts, a sub-nav, the section body, and the issues rail whose total is the sum of its rows. Every figure is a read that succeeded: a part that failed says so with Retry and
 * the rest still render. It observes and overrides; it approves nothing. The shell's bootstrap keeps the attention counts fresh, so the console adds no poll of its own.
 */
export function AdminConsole({ userId, userEmail, nowIso, initial }: { userId: string; userEmail: string; nowIso: string; initial: DashboardData }) {
  const [data, setData] = useState(initial);
  const [section, setSection] = useState("Sources");
  const [sub, setSub] = useState("Provisional review");
  const [issueFilter, setIssueFilter] = useState<string | null>(null);
  const [view, setView] = useState(0);
  const live = useBootstrapStore((s) => s.data?.adminAttention ?? null) as AttentionCounts | null;
  const attention = live ?? ok(data.attention);
  const sources = ok(data.sources);
  const provisional = ok(data.provisional);
  const orgs = ok(data.orgs);
  const members = ok(data.members);
  const staged = ok(data.staged);
  const counts = ok(data.counts);
  const def = SECTIONS.find((s) => s.name === section) ?? (SECTIONS[0] as SectionDef);
  const dateLabel = formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const nowMs = Date.parse(nowIso);

  const refresh = async () => {
    const [o, s] = await Promise.all([requestJson<Omit<DashboardData, "sources" | "provisional">>("/api/admin/overview"), requestJson<{ sources: AdminSource[]; provisional: AdminProvisional[] }>("/api/admin/sources")]);
    setData((d) => ({ ...d, ...(o.ok && o.data ? o.data : {}), ...(s.ok && s.data ? { sources: { ok: true as const, data: s.data.sources }, provisional: { ok: true as const, data: s.data.provisional } } : { sources: { ok: false as const, error: s.error ?? "The registry did not load." }, provisional: { ok: false as const, error: s.error ?? "The registry did not load." } }) }));
    refreshBootstrap();
    setView((n) => n + 1);
  };
  const go = (t: IssueNavTarget) => {
    const d = SECTIONS.find((s) => s.name === t.section);
    if (!d) return;
    setSection(d.name);
    setSub(d.tabs.includes(t.tab) ? t.tab : (d.tabs[0] as string));
    setIssueFilter(null);
  };
  const pickSection = (name: string) => {
    setSection(name);
    setSub((SECTIONS.find((s) => s.name === name)?.tabs[0]) as string);
    setIssueFilter(null);
  };
  const tabs = def.tabs.map((t) => {
    const n = subTabCount(t, { attention, sources: sources?.length ?? null, disagreements: counts?.disagreements ?? null });
    return { key: t, label: n === null ? t : `${t} · ${formatNumber(n)}`, active: t === sub, onClick: () => { setSub(t); setIssueFilter(null); } };
  });
  const body = () => {
    if (section === "Workspaces") return orgs && members ? <WorkspacesOverview orgs={orgs} members={members.rows} capped={members.capped} userId={userId} userEmail={userEmail} /> : <PartFailure what="Organizations" error={(!data.orgs.ok ? data.orgs.error : !data.members.ok ? data.members.error : "")} onRetry={refresh} />;
    if (section === "Sources") {
      if (sub === "Bulk add") return <BulkImportView />;
      if (sub === "Tier disagreements") return <TierDisagreementsView />;
      return (
        <div className={styles.stack}>
          {issueFilter ? <IssueFilterCaption label={issueFilterLabel(issueFilter)} onClear={() => setIssueFilter(null)} /> : null}
          {sources && provisional ? (
            <SourceRegistryCard
              key={`${sub === "Provisional review" || sub === "Spot-check" ? "provisional" : "registry"}-${view}`}
              sources={sources}
              provisional={provisional}
              initialView={(sub === "Provisional review" || sub === "Spot-check" ? "provisional" : "registry") as RegistryView}
              nowIso={nowIso}
              pendingTotal={attention?.provisional_sources_pending ?? null}
              stagedCount={staged ? staged.total : null}
              onOpenStaged={() => go({ section: "Ingest", tab: "Staged updates" })}
              onSourceChanged={(id, patch) => setData((d) => (d.sources.ok ? { ...d, sources: { ok: true, data: d.sources.data.map((s) => (s.id === id ? { ...s, ...patch } : s)) } } : d))}
              onProvisionalRemoved={(id) => setData((d) => (d.provisional.ok ? { ...d, provisional: { ok: true, data: d.provisional.data.filter((p) => p.id !== id) } } : d))}
            />
          ) : (
            <PartFailure what="The source registry" error={(!data.sources.ok ? data.sources.error : !data.provisional.ok ? data.provisional.error : "")} onRetry={refresh} />
          )}
        </div>
      );
    }
    if (section === "Ingest") {
      if (sub === "Flags & rejections") return <FlagsQueue counts={attention} nowMs={nowMs} />;
      if (sub === "Staged updates") return staged ? <StagedTransitView rows={staged.rows} total={staged.total} /> : <PartFailure what="Staged updates" error={!data.staged.ok ? data.staged.error : ""} onRetry={refresh} />;
      if (sub === "Dispatch") return <DispatchPanel />;
      if (sub === "Statutory rows") return <StatutoryRowsUpload />;
      return <CorrectionsTab />;
    }
    if (section === "Coverage") {
      if (sub === "Catalogue") return <CoverageCatalogueView />;
      if (sub === "Coverage matrix") return <CoverageMatrixView onBulkAdd={(iso) => { setSection("Sources"); setSub("Bulk add"); setIssueFilter(`coverage:${iso}`); }} />;
      return <JurisdictionReviewView />;
    }
    if (section === "Research pipeline") return <ResearchPipelineView />;
    return sub === "Assumptions" ? <AssumptionRegisterView /> : sub === "Inferences" ? <InferencesView /> : sub === "Admin events" ? <AdminEventsView /> : <ErrorGroupsView />;
  };
  return (
    <div data-admin-console="">
      <div className={styles.head}>
        <Masthead
          title="Platform admin"
          dateLabel={dateLabel}
          nowIso={nowIso}
          eyebrowSuffix="Operator view"
          dek={<>Workspaces, sources, ingest, coverage · {counts ? `${formatNumber(counts.harnessRuns)} harness runs this month` : "harness runs not loaded"}{attention ? ` · ${formatNumber(attention.total)} items need attention` : ""}</>}
          commandBar={<ShellCommandBar placeholder="Search sources, workspaces, flags" />}
        />
      </div>
      <div className={styles.frame}>
        <div className={styles.main}>
          <div className={styles.tiles}>
            {SECTIONS.map((s) => {
              const n = tileCount(s.name, { orgs: orgs?.length ?? null, attention, counts });
              return (
                <button key={s.name} type="button" {...(n === null ? { "data-part": "page-failure" } : {})} aria-pressed={s.name === section} className={`${styles.tile} ${s.name === section ? styles.tileOn : ""}`} onClick={() => pickSection(s.name)}>
                  <StatBlock size="tile" label={s.name} value={n === null ? "—" : formatNumber(n)} note={n === null ? "did not load" : s.sub} tone={s.name === "Sources" && n ? "critical" : "default"} />
                </button>
              );
            })}
            <Link href="/admin/factors" prefetch={false} className={styles.tile}>
              <StatBlock size="tile" label="Emission factors" value={counts ? formatNumber(counts.factors) : "—"} note={counts ? `${formatNumber(counts.factors)} live rows, read-only` : "did not load"} />
            </Link>
            <Link href="/admin/parts" prefetch={false} className={styles.tile}>
              <StatBlock size="tile" label="Parts" value="1" note="Every part, mounted with fixtures" />
            </Link>
          </div>
          <TabRow ariaLabel={`${section} views`} semantics="tablist" tabs={tabs} />
          {body()}
        </div>
        <aside className={styles.rail}>
          <IssuesRail counts={attention} failed={!data.attention.ok && !live ? data.attention.error : null} onNavigate={go} onRetry={refresh} />
          {orgs && members ? <UsageCard orgs={orgs} members={members.rows} capped={members.capped} /> : <RailCard title="Who is using the platform"><PartFailure what="Memberships" error={!data.orgs.ok ? data.orgs.error : !data.members.ok ? data.members.error : ""} onRetry={refresh} /></RailCard>}
          <RailCard title="Read-only controls">
            <p className={styles.note}>Per-organization settings are changed in that organization&apos;s own settings. This console observes and overrides after the fact; every override is recorded with a reason.</p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>Refresh</Button>
          </RailCard>
        </aside>
      </div>
    </div>
  );
}
