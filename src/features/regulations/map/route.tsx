// Ported from old_repo/src/app/map/page.tsx (lines 1-94)
// The /map route as one server function: the workspace's cached read of the regulation rows (the list's own RPC), the coverage of the priority regions on the caller's client, the masthead with its counts, the page. A failed
// items read is the shell's PageFailure with Retry; a failed coverage read is said inside the rail. `?region=` takes a priority-region id or one code (the Coverage gaps rail links with a region id).
import { unstable_rethrow } from "next/navigation";

import { userClient } from "@/core/db";
import { log } from "@/core/shared";
import { countNoun, formatLocaleDate } from "@/core/shared";
import { pageSession } from "@/features/account/server/page-session";
import { Masthead } from "@/ui";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { PageFailure } from "@/ui/shell/PageFailure";

import { MapPage } from "./MapPage";
import { regionCodes } from "./region-filter";
import { getMapItems } from "./read";
import { readRegionCoverage } from "./region-coverage";
import { rollup } from "./rollup";

export async function MapRoute({ searchParams }: { searchParams: Promise<{ region?: string | string[] }> }) {
  const session = await pageSession("/map");
  if ("failed" in session) return <PageFailure what="The map" />;
  const region = (await searchParams).region;
  const data = await (async () => {
    const db = await userClient();
    const [items, coverage] = await Promise.all([getMapItems(db, session.orgId).then((r) => { if (!r.ok) throw new Error(r.error); return r.value; }), readRegionCoverage(db).catch((e) => (unstable_rethrow(e), log.warn("[map] coverage did not load:", e instanceof Error ? e.message : String(e)), null))]);
    return { items, coverage };
  })().catch((e: unknown) => (unstable_rethrow(e), log.warn("[map] the map did not load:", e instanceof Error ? e.message : String(e)), null));
  if (!data) return <PageFailure what="The map" />;
  const rows = rollup(data.items);
  const immediate = rows.filter((r) => r.band.key === "immediate").length;
  return (
    <>
      <div className="cl-list-surface-masthead">
        <Masthead
          title="Regulatory map"
          dateLabel={formatLocaleDate(new Date(session.nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
          nowIso={session.nowIso}
          commandBar={<ShellCommandBar placeholder='Search a jurisdiction, or ask "where are my immediate items?"' />}
          dek={`${countNoun(rows.length, "jurisdiction")} live · ${countNoun(data.items.length, "active item")} · ${countNoun(immediate, "jurisdiction")} with immediate items · marker size = item count · colour = highest band present`}
        />
      </div>
      <MapPage items={data.items} coverage={data.coverage} activeCodes={regionCodes(Array.isArray(region) ? region[0] : region)} />
    </>
  );
}
