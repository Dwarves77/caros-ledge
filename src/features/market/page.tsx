// Ported from old_repo/src/app/market/page.tsx (lines 116-249)
// The /market page: ONE reader (readMarket) and the view that draws it. Each part of the page reads independently on the caller's own client; one server instant for everything that judges freshness.
import { isServiceConfigured, serviceClient, userClient } from "@/core/db";
import { readThemeChips } from "@/core/detail";
import { radarClients, readFlywheelRadar, readWhyMatters } from "@/features/flywheel/radar/read";
import { pageSession } from "@/features/account/server/page-session";
import { loadSurfaceDenominator } from "@/features/coverage/server";
import { PageFailure } from "@/ui/shell/PageFailure";

import { selectHeadlineSeries } from "./lib/headline";
import { readMarket, section } from "./read";
import { MarketView } from "./ui/MarketView";

export default async function MarketPage() {
  const session = await pageSession("/market");
  if ("failed" in session) return <PageFailure what="Market Intelligence" />;
  const db = await userClient();
  const [read, coverage, chips, radar] = await Promise.all([
    readMarket(db, { orgId: session.orgId, edgeDb: isServiceConfigured() ? serviceClient() : null }),
    loadSurfaceDenominator("market_intel", { db: () => db }),
    section("themes", () => readThemeChips(db, { surface: "market", max: 6 })),
    section("radar", () => readFlywheelRadar(radarClients(db), { kind: "surface", surface: "market" })),
  ]);
  // the two "Why this matters" lines of each headline card: the regulation tied to its entity with the next dated obligation and the operations or research item tied to it
  const cards = read.series.ok ? selectHeadlineSeries(read.series.data.board).cards.flatMap((c) => (c.row.id ? [{ key: c.familyKey, id: c.row.id, subject: c.label }] : [])) : [];
  const why = await section("why this matters", () => readWhyMatters(db, "market_series", cards, session.nowIso));
  return <MarketView read={read} nowIso={session.nowIso} coverage={{ denominator: coverage.denominator, error: coverage.error }} chips={chips.ok ? chips.data : null} radar={radar.ok ? radar.data : null} why={why.ok ? Object.fromEntries(cards.map((c) => [c.key, why.data.get(c.id) ?? []])) : null} />;
}
