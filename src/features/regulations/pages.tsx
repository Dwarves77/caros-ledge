// Ported from old_repo/src/app/regulations/page.tsx (lines 14-72)
// Ported from old_repo/src/app/regulations/[slug]/page.tsx (lines 68-226)
// Ported from old_repo/src/app/regulations/register/page.tsx (lines 1-25)
// The three Regulations routes as server functions (each src/app route re-exports one). Every read is on the caller's own client; a failed read is the shell's PageFailure with Retry (IMP-068), a
// missing item is the not-found page, and the render instant is the request's one (`pageSession`).
import { notFound, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";

import { userClient } from "@/core/db";
import { applyIdRedirect, loadDetail } from "@/core/detail";
import { corridorsTouching } from "@/core/entities";
import { log } from "@/core/shared";
import { readWorkspaceProfile } from "@/core/workspace";
import { pageSession } from "@/features/account/server/page-session";
import { loadSurfaceDenominator } from "@/features/coverage/server";
import { buildRegisterQuerySpec, defaultJurisdictionFilter, fetchObligationRegisterPage, fetchRegisterFacetOptions, KIND_LABELS, readUpcoming } from "@/features/obligations";
import { readThemeChips } from "@/core/detail";
import { Masthead, RailCard } from "@/ui";
import { PageFailure } from "@/ui/shell/PageFailure";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { PageFrame } from "@/ui/shell/PageFrame";
import { formatLocaleDate } from "@/core/shared";

import { DetailView } from "./DetailView";
import { ObligationRegister } from "./ObligationRegister";
import { CoverageLine, ObligationsRailCard } from "./rail";
import { RegulationsLedger } from "./RegulationsLedger";
import { CorridorsApplied } from "./CorridorsApplied";
import { readRegulationsFirstPage } from "./list-read";

const dateLabel = (nowIso: string): string => formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const warn = (what: string, e: unknown): null => (unstable_rethrow(e), log.warn(`[regulations] ${what} did not load:`, e instanceof Error ? e.message : String(e)), null);
/** A page's primary read: its value, or null after logging (Next's own redirect and not-found signals pass through). The caller renders the failure page with Retry. */
const attempt = <T,>(what: string, read: () => Promise<T>): Promise<T | null> => read().catch((e: unknown) => warn(what, e));

/** /regulations: the first page, the counts, the theme strip, the obligations rail, the coverage line. A failed list read is the page failing; a failed side read is said where it sits. */
export async function RegulationsIndex() {
  const session = await pageSession("/regulations");
  if ("failed" in session) return <PageFailure what="Regulations" />;
  const db = await userClient();
  const today = session.nowIso.slice(0, 10);
  const data = await attempt("the list", async () => {
    const [profileRead, chips, coverage] = await Promise.all([
      readWorkspaceProfile(db, session.orgId).catch((e) => warn("profile", e)),
      readThemeChips(db, { surface: "regulations" }).catch((e) => warn("themes", e)),
      loadSurfaceDenominator("regulations", { db: () => db }).catch((e) => warn("coverage", e)),
    ]);
    const profile = profileRead?.profile;
    const [first, upcoming] = await Promise.all([
      readRegulationsFirstPage(db, session.orgId, profileRead && !profileRead.failed ? profile : null),
      readUpcoming(db, { limit: 8, jurisdictionFilter: defaultJurisdictionFilter(profile?.jurisdictions) }, today).catch((e) => warn("upcoming obligations", e)),
    ]);
    return { first, chips, upcoming, coverage, profileFailed: profileRead === null || profileRead.failed };
  });
  if (!data || data.first.failed) return <PageFailure what="Regulations" />;
  const { first, chips, upcoming, coverage, profileFailed } = data;
  const degraded = [
    ...(profileFailed ? ["Your workspace profile did not load, so the obligations rail is not narrowed to your jurisdictions."] : []),
    ...(first.timelineFailures > 0 ? ["Milestone dates did not load for some rows, so their timelines are blank."] : []),
    ...(first.overridesFailed ? ["Your workspace's owner, dismissal and archive marks did not load, so the rows show none."] : []),
  ];
  return (
    <Suspense fallback={null}>
      <RegulationsLedger
        initial={first.rows}
        aggregates={first.aggregates}
        hasMore={first.hasMore}
        nowIso={session.nowIso}
        chips={chips}
        degraded={degraded}
        rail={<ObligationsRailCard events={upcoming?.events ?? []} failed={upcoming === null} nowIso={session.nowIso} />}
        below={<CoverageLine denominator={coverage?.denominator ?? null} failed={coverage === null || coverage.error !== null} surface="regulations" />}
      />
    </Suspense>
  );
}

/** /regulations/[slug]: the id decision, the one detail load, the obligation events and register, the corridors. */
export async function RegulationDetailRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const id = decodeURIComponent(slug);
  const session = await pageSession(`/regulations/${slug}`);
  if ("failed" in session) return <PageFailure what="This regulation" />;
  const db = await userClient();
  const today = session.nowIso.slice(0, 10);
  const data = await attempt(id, async () => {
    await applyIdRedirect("regulations", id, db);
    const detail = await loadDetail(
      "regulations",
      id,
      async ({ uuid, resource }) => {
        const iso = resource.jurisdictionIso ?? [];
        const [events, register, corridors] = await Promise.all([
          readUpcoming(db, { itemId: uuid, limit: 20 }, today).catch((e) => warn("obligation events", e)),
          fetchObligationRegisterPage(db, buildRegisterQuerySpec({ itemId: uuid, limit: 200 }, today)).catch((e) => warn("obligation register", e)),
          iso.length > 0 ? corridorsTouching(db, iso).catch((e) => warn("corridors", e)) : Promise.resolve([]),
        ]);
        return { events, register, corridors };
      },
      db,
      session.orgId,
      session.nowIso,
    );
    if (detail.notFound) return "missing" as const;
    return { detail, ...detail.itemScoped };
  });
  if (data === null) return <PageFailure what="This regulation" />;
  if (data === "missing") notFound();
  const { detail, events, register, corridors } = data;
  return (
    <DetailView
      resource={detail.resource}
      changelog={detail.changelog}
      dispute={detail.dispute}
      sections={detail.sections}
      claimTiers={detail.claimTiers}
      claimsDegraded={detail.claimsDegraded}
      recommendedActions={detail.recommendedActions}
      crossPage={detail.crossPage}
      connectionRows={detail.connectionRows}
      events={events?.events ?? []}
      eventsFailed={events === null}
      kindLabels={KIND_LABELS}
      hasWorkspace={session.orgId !== null}
      nowIso={session.nowIso}
    >
      <ObligationRegister variant="item" initial={register} failed={register === null} />
      <CorridorsApplied corridors={(corridors ?? []).map((c) => ({ entityId: c.entityId, label: c.label, jurisdictions: c.jurisdictions.map((j) => ({ code: j.code, name: j.name })) }))} failed={corridors === null} />
    </DetailView>
  );
}

/** /regulations/register: the whole obligation register, its first page read here. */
export async function ObligationRegisterRoute() {
  const session = await pageSession("/regulations/register");
  if ("failed" in session) return <PageFailure what="The obligation register" />;
  const db = await userClient();
  const today = session.nowIso.slice(0, 10);
  const [page, facets] = await Promise.all([
    fetchObligationRegisterPage(db, buildRegisterQuerySpec({ limit: 60 }, today)).catch((e) => warn("register", e)),
    fetchRegisterFacetOptions(db, today).catch((e) => warn("register facets", e)),
  ]);
  return (
    <Suspense fallback={null}>
      <div className="cl-list-surface-masthead">
        <Masthead title="Obligation register" dek="Every dated obligation on file, soonest first." dateLabel={dateLabel(session.nowIso)} nowIso={session.nowIso} commandBar={<ShellCommandBar placeholder="Search regulations" />} />
      </div>
      <PageFrame
        rail={
          <RailCard title="Obligation positions">
            <p className="cl-detail-link-note">Positions: your duty, carrier pass-through, customer contract, monitor. Each obligation shows the position it has for a freight forwarder.</p>
          </RailCard>
        }
      >
        <ObligationRegister variant="list" initial={page} failed={page === null} jurisdictions={facets?.jurisdictions ?? []} modes={facets?.modes ?? []} />
      </PageFrame>
    </Suspense>
  );
}
