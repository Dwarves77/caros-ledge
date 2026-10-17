// ONE system (P2-13): the Dashboard, the watchlist, Standard Search and the Assistant read what the fixture turn wrote. The whole turn runs on the shared fixture database through the real wiring (tests/integration/world.ts);
// the page readers are then called on that same database, and every assertion is about the item THE TURN minted (its surface link, its source's rating, its binding date, its place in the surface count). The only rows added by
// hand are the caller's own (their workspace membership) and the watch the caller toggles through the real route; the database functions the readers call are the stand-ins of tests/_support/workspace-reads.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runTurn } from "@/core/turn";
import { POST as ask } from "@/features/assistant/api/ask";
import { readCounts, readDigest } from "@/features/dashboard/read/digest";
import { buildChangedRows, buildDueNextRows } from "@/features/dashboard/rows";
import { readSurfaceCounts } from "@/features/lists";
import { POST as watch } from "@/features/watchlist/api/watch";
import { readWatchlist } from "@/features/watchlist/read/watchlist";

import type { Row } from "../_support/memdb.ts";
import { scriptWithRpc } from "../_support/personas-rpc.ts";
import { installWorkspaceReadRpcs } from "../_support/workspace-reads.ts";
import { call, clientFor, ORG_A, USER } from "../workspace/_world.ts";

import { CENSUS, DOC_TEXT, DOC_URL, fixture, NOW, SRC } from "./world.ts";

const BATCH = JSON.stringify({ verdicts: [{ census_id: CENSUS, verdict: "on_vertical", basis: "EU emissions regulation: core sustainability scope", reviewer: "turn-test" }] });
/** The publisher's page with a dated duty added, so the connect stage's forward-event extractor finds a compliance deadline (the base page carries only an entry-into-force date). */
const DUTY = "Article 5. Operators shall submit the first verified emissions report to the competent authority no later than 31 March 2027.";

async function theTurn() {
  const f = fixture({ routes: { [DOC_URL]: () => new Response(`${DOC_TEXT}\n${DUTY}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }) } });
  const r = await runTurn({ stage: "all", mode: "apply", input: { intake: { census: { limit: 5 } }, propagate: { producers: { only: "ecb-fx" } }, briefs: { batch: { kind: "screen-verdicts", content: BATCH } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(r.exit, 0);
  const ledger = f.db.rows("harness_runs");
  const minted = ((ledger.find((x) => x.family === "ledger-consume")?.outputs as { ids: { minted_item_ids: string[] } }).ids.minted_item_ids)[0] as string;
  installWorkspaceReadRpcs(f.db);
  // The caller: a member of a workspace. (The turn is the machine; a person's membership is the one thing it does not write.)
  f.db.seed("organizations", [{ id: ORG_A, name: "Org A", slug: "org-a" }]);
  f.db.seed("org_memberships", [{ id: "cccccccc-0000-4000-8000-000000000001", org_id: ORG_A, user_id: USER.member, role: "member", created_at: "2026-01-01T00:00:00Z" }]);
  f.db.seed("profiles", [{ id: USER.member, full_name: "Pat Lee", display_name: null }]);
  return { ...f, minted };
}

test("the Dashboard: the item the turn minted is a Due-next row with its surface link, a What-changed row, and carries its source's rating; the counts equal the surface tiles", async () => {
  const t = await theTurn();
  const d = await readDigest(t.db.client, ORG_A);
  const due = buildDueNextRows(d.dueNext, NOW);
  assert.deepEqual(due.map((r) => [r.id, r.href, r.dueDays]), [[t.minted, `/regulations/${t.minted}`, 167]], "the deadline the flywheel extracted and synced (31 March 2027) is the nearest binding date");
  assert.equal(due[0]?.title.startsWith("Regulation (EU) 2023/9999"), true);
  assert.equal(due[0]?.tier, 1, "the rating of the source the capture came from");
  const changed = buildChangedRows(d.feed, d.candidates, d.changelogField, NOW);
  assert.deepEqual(changed.map((r) => [r.id, r.isNew, r.href]), [[t.minted, true, `/regulations/${t.minted}`]]);
  assert.equal(d.windowDays, 7, "the fixture runs under a weekly cadence, so the window is the 7 days the cadence states (90 only while the cadence is off)");

  const counts = await readCounts(t.db.client, ORG_A);
  const tiles = await readSurfaceCounts(t.db.client, ORG_A, "regulations");
  assert.deepEqual(counts.regulations, tiles, "the band tiles count what the Regulations surface's own tiles count");
  assert.equal(Object.values(counts.regulations.byPriority).reduce((n, x) => n + x, 0), 1);
  assert.deepEqual(counts.surfaces, { regulations: 1, marketIntel: 0, research: 0, operations: 0 }, "the rail counts the verified items the turn minted, per surface");
  assert.equal(counts.surfaces.regulations, (await readSurfaceCounts(t.db.client, ORG_A, "regulations"))?.totalItems);
});

test("the watchlist: a watch toggled through the real route appears on the rail with the minted item's title, surface link and rating", async () => {
  const t = await theTurn();
  scriptWithRpc(t.db);
  const r = await call(watch, "member", "POST", "/api/watchlist", { itemType: "reg", itemId: t.minted });
  assert.equal(r.status, 200);
  const w = await readWatchlist(clientFor(t.db as never, "member"), { userId: USER.member, orgId: ORG_A }, 14, NOW);
  assert.deepEqual(w.items.map((i) => [i.scope, i.type, i.id, i.title.slice(0, 22), i.fields?.href, i.fields?.tier]), [["personal", "reg", t.minted, "Regulation (EU) 2023/9", `/regulations/${t.minted}`, 1]]);
  assert.equal(w.items[0]?.dueDays, 167);
});

test("the Assistant: a question about the minted regulation is answered with a citation to it that carries the capture's source rating, and no model, key or network call is made", async () => {
  const t = await theTurn();
  scriptWithRpc(t.db);
  const real = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => (network += 1, new Response("{}"))) as never;
  try {
    const r = await call(ask, "member", "POST", "/api/ask", { question: "Regulation 2023/9999" });
    assert.equal(r.status, 200);
    const hits = r.body.hits as { id: string; tier: number | null; href: string; source: { name: string } | null; excerpt: string | null }[];
    assert.deepEqual(hits.map((h) => [h.id, h.tier, h.href, h.source?.name]), [[t.minted, 1, `/regulations/${t.minted}`, "EUR-Lex"]], "the citation is the minted item, rated by the registered source of the capture");
    assert.match(String(hits[0]?.excerpt), /Catalogue record/);
    assert.equal(r.body.empty, false);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(network, 0, "the fetch stub saw nothing: the answer is retrieval over the database, never a model");
  const source = t.db.rows("sources").find((s) => s.id === SRC) as Row;
  assert.equal(source.base_tier, 1, "the rating on the citation is the source row's, not text");
});
