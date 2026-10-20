// P2-15b: each read the page sweep found silent now states its failure beside its data, with Retry (INV-263). The sweep proves that every refused read is stated somewhere; these assert WHICH block says it and that nothing
// the failed read would have supplied is drawn in its place (a default profile ranked as if configured, a tally of loaded rows, a zero).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";

import { readScrapeStateOrClosed } from "@/core/fetch";
import { readWorkspaceProfile } from "@/core/workspace";
import { readMarketDetail } from "@/features/market/read";
import { CarbonFindings } from "@/features/market/ui/MarketSignalDetail";
import { crossPagePresence } from "@/ui/detail";
import { InferenceSection } from "@/ui/detail/InferenceSection";

import { renderApp, textOf } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const drawn = async (path: string, render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path }));
const refused = async (table: string, path: string, render: () => Promise<ReactNode>): Promise<string> => {
  const w = memberWorld();
  w.failTable(table);
  return drawn(path, render);
};
const refusedRpc = async (rpc: string, path: string, render: () => Promise<ReactNode>): Promise<string> => {
  const w = memberWorld();
  w.failRpc(rpc);
  return drawn(path, render);
};
const RETRY = /Retry/;
const ORG = "11111111-1111-4111-8111-111111111111";

test("Dashboard: a refused workspace profile, milestone read and hold state are each their own sentence with Retry, and the brief still draws", async () => {
  const page = async () => (await import("@/features/dashboard/page")).default();
  for (const [table, note] of [
    ["workspace_settings", /workspace profile did not load, so this brief is ranked without your sectors/],
    ["item_timelines", /Milestone dates did not load for some rows/],
    ["system_state", /collection hold state did not load/],
  ] as const) {
    const text = await refused(table, "/", page);
    assert.match(text, note, table);
    assert.match(text, RETRY, table);
    assert.match(text, /Due next/, `${table}: the other blocks still render`);
  }
});

test("Watchlist: a refused milestone read is stated on the surface; Regulations states the profile, milestones, marks and theme strip each by name", async () => {
  assert.match(await refused("item_timelines", "/watchlist", async () => (await import("@/features/watchlist/page")).default()), /Milestone dates did not load for some rows/);
  const page = async () => (await import("@/features/regulations/pages")).RegulationsIndex();
  for (const [table, note] of [
    ["workspace_settings", /obligations rail is not narrowed to your jurisdictions/],
    ["item_timelines", /Milestone dates did not load/],
    ["workspace_item_overrides", /owner, dismissal and archive marks did not load/],
    ["connection_themes", /theme strip did not load/],
  ] as const) {
    const text = await refused(table, "/regulations", page);
    assert.match(text, note, table);
    assert.match(text, RETRY, table);
  }
});

test("Market, Research and Operations: a refused get_surface_counts blanks the tiles and the Region totals with a note, and no tally of loaded rows stands in for the count", async () => {
  const pages: Array<[string, () => Promise<ReactNode>]> = [
    ["/market", async () => (await import("@/features/market/page")).default()],
    ["/research", async () => (await import("@/features/research/page")).ResearchRoute()],
    ["/operations", async () => (await import("@/features/operations/page")).OperationsRoute()],
  ];
  for (const [path, render] of pages) {
    memberWorld(); // a fresh world: the draw reads the last one scripted
    assert.match(await drawn(path, render), /\d+ active (signals|findings|items)/, `${path}: healthy, the count is drawn`);
    const text = await refusedRpc("get_surface_counts", path, render);
    assert.match(text, /counts for this list/, path);
    assert.match(text, RETRY, path);
    assert.doesNotMatch(text, /\d+ active (signals|findings|items)/, `${path}: a tally of loaded rows is not the count`);
  }
});

test("Operations: a refused state cost read is stated in the Coverage gaps card", async () => {
  const text = await refused("state_cost_facts", "/operations", async () => (await import("@/features/operations/page")).OperationsRoute());
  assert.match(text, /state-level cost facts did not load/);
});

test("Details: a refused inference read is the Inferences section stating it with Retry on all four detail pages; a refused coverage read is stated on the operations profile", async () => {
  const pages: Array<[string, () => Promise<ReactNode>]> = [
    ["/regulations/o3", async () => (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) })],
    ["/market/m1", async () => (await import("@/features/market/detail-page")).MarketDetailRoute({ params: Promise.resolve({ slug: "m1" }) })],
    ["/research/r1", async () => (await import("@/features/research/detail-page")).ResearchDetailRoute({ params: Promise.resolve({ slug: "r1" }) })],
    ["/operations/o1", async () => (await import("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) })],
  ];
  for (const [path, render] of pages) {
    const text = await refused("inference_records", path, render);
    assert.match(text, /The inferences did not load/, path);
    assert.match(text, RETRY, path);
  }
  assert.match(await refused("region_dimension_coverage", "/operations/o1", pages[3]![1]), /regional coverage data did not load/);
});

test("the Inferences section: failed it states so with Retry and the section index lists it; healthy with nothing admissible it draws nothing", () => {
  const failed = textOf(renderApp(createElement(InferenceSection, { failed: true, onRetry: () => undefined })));
  assert.match(failed, /The inferences did not load/);
  assert.match(failed, RETRY);
  assert.equal(crossPagePresence({ degraded: ["inferences"] }).inferences, true);
  assert.equal(crossPagePresence({ degraded: [] }).inferences, false);
  assert.equal(textOf(renderApp(createElement(InferenceSection, { inferences: null }))), "");
});

test("the market detail reads the carbon factors only for a signal that draws a carbon block; a corridor signal whose read is refused says so with Retry", async () => {
  const skipped = memberWorld();
  const none = await readMarketDetail(skipped.db as Any, { id: "m1", needsCarbon: false });
  assert.equal(none.carbon.ok, false);
  assert.ok(!skipped.reads().tables.includes("emission_factors"), "no carbon read for a signal that does not draw one");
  for (const table of ["emission_factors"]) {
    const w = memberWorld();
    w.failTable(table);
    const d = await readMarketDetail(w.db as Any, { id: "m1" });
    assert.equal(d.carbon.ok, false, table);
    const text = textOf(renderApp(createElement(CarbonFindings, { bundle: d as Any, item: { jurisdictionIso: [], modes: [] }, nowIso: "2026-10-17T00:00:00.000Z" })));
    assert.match(text, /Carbon intensity did not load/, table);
    assert.match(text, RETRY, table);
  }
});

test("the profile and hold-state readers say when they fell back; the fall-back itself is unchanged (the default profile, fail closed)", async () => {
  const w = memberWorld();
  assert.equal((await readWorkspaceProfile(w.db as Any, ORG)).failed, false);
  w.failTable("workspace_settings");
  const bad = await readWorkspaceProfile(w.db as Any, ORG);
  assert.equal(bad.failed, true);
  assert.deepEqual(bad.profile.jurisdictions, { global: 1 });
  const hold = memberWorld();
  hold.failTable("system_state");
  const closed = await readScrapeStateOrClosed(hold.db as Any);
  assert.equal(closed.unreadable, true);
  assert.equal(closed.state.cadence, "off");
});
