// R2d I13 and I16, the readers that must agree with the list: Market, Research and Operations read the WORKSPACE'S lists (the member's priority and archive applied) instead of the platform's; the Related section
// of a market signal is the flywheel's connections, not a scan of the corpus; the by-id reads are the database's; a figure the brief states is not scrubbed; the customer reads sentences, never a driver's text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createElement } from "react";

import { statusWord } from "@/core/detail/status-words";
import { log } from "@/core/shared/log";
import { readFailure, DB_SENTENCES } from "@/core/http/failure";
import { CrossPageSection } from "@/ui/detail/CrossPageSection";
import { readMarket } from "@/features/market/read";
import { readOperationsPage } from "@/features/operations/read/operations-reads";
import { readResearchPage } from "@/features/research/read/research-reads";

import { memoryDb } from "../_support/memory-db.ts";
import { renderApp, textOf } from "../_support/render.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T12:00:00Z");
const recording = () => {
  const called: Array<{ name: string; args: unknown }> = [];
  const m = memoryDb({ regions: [], region_dimension_coverage: [], regional_data_facts: [], state_cost_facts: [], intelligence_items: [], derived_values: [], research_assessments_current: [], sources: [], source_bias_tags: [] }, { rpc: (name, args) => (called.push({ name, args }), { data: [] }) });
  const client = new Proxy(m.db as object, { get: (t, k) => (k === "rpc" ? (n: string, a?: unknown) => { const run = Promise.resolve((m.db as { rpc: (n: string, a?: unknown) => Promise<unknown> }).rpc(n, a)); return Object.assign(run, { range: () => run }); } : Reflect.get(t, k)) });
  return { called, client: client as never };
};

test("surfaces:28 a member's Market, Research and Operations pages read the workspace lists with the member's org; with no workspace they read the public lists", async () => {
  for (const [read, withOrg, without] of [
    [(db: never, org: string | null) => readMarket(db, { orgId: org }), "get_market_intel_items", "get_market_intel_items_public"],
    [(db: never, org: string | null) => readResearchPage(db, org), "get_research_items", "get_research_items_public"],
    [(db: never, org: string | null) => readOperationsPage(db, NOW.toISOString(), org), "get_operations_items", "get_operations_items_public"],
  ] as const) {
    const member = recording();
    await read(member.client, ORG);
    assert.ok(member.called.some((c) => c.name === withOrg && (c.args as { p_org_id?: string }).p_org_id === ORG), `${withOrg} is read for the member's org`);
    assert.ok(!member.called.some((c) => c.name === without), `${without} is not read for a member: it carries the platform's priority and archive`);
    const anon = recording();
    await read(anon.client, null);
    assert.ok(anon.called.some((c) => c.name === without), `${without} is the list when there is no workspace`);
  }
});

test("surfaces:28 the market detail page reads no corpus for 'Related': the section is the flywheel's connections", () => {
  const read = readFileSync("src/features/market/read.ts", "utf8");
  assert.doesNotMatch(read.slice(read.indexOf("export async function readMarketDetail")), /readCategory|related signals/, "the detail read no longer scans the whole market corpus");
  assert.doesNotMatch(readFileSync("src/features/market/ui/MarketDetailView.tsx", "utf8"), /RelatedSignalLinks|bundle\.related/);
});

test("migrations 0095 and 0096 gate on the one item rule and assert membership; the readers call them by their names", () => {
  const byIds = readFileSync("supabase/migrations/0095_workspace_items_by_ids.sql", "utf8");
  assert.match(byIds, /FROM public\._workspace_active_items\(p_org_id\) a/);
  assert.match(byIds, /public\.item_is_admissible\(ii\.provenance_status, a\.effective_archived, ii\.replaced_by\)/);
  assert.match(readFileSync("src/features/dashboard/read/items.ts", "utf8"), /rpc\("get_workspace_items_by_ids"/);
  const lists = readFileSync("supabase/migrations/0096_workspace_category_lists.sql", "utf8");
  assert.equal((lists.match(/_assert_org_membership\(p_org_id\)/g) ?? []).length, 2, "both workspace lists assert membership");
  assert.equal((lists.match(/public\.item_is_admissible\(ii\.provenance_status, COALESCE\(wo\.is_archived, ii\.is_archived\), ii\.replaced_by\)/g) ?? []).length, 2);
  assert.equal((lists.match(/COALESCE\(wo\.priority_override, ii\.priority\)/g) ?? []).length >= 4, true, "the override is laid over the priority and the order");
});

test("I7 the pre-contract brief scrubber removes a labelled statistic and leaves a figure the brief states: '1.250 EUR' was deleted with the weights", () => {
  const theme = { memberCount: 1, pages: [], hasBrief: true, title: "Levy theme", stale: false, supersedesThemeId: null, briefMd: "The levy is 1.250 EUR per tonne (density 0.412) and the weight is 0.875 kg. Item scores 0.731.", sections: null, forwardOutlook: { horizons: [] }, membersByPage: [], cluster: null, ramificationsMissing: false };
  const out = textOf(renderApp(createElement(CrossPageSection, { surfaceKey: "regulations", surfaceLabel: "Regulations", crossPage: { theme } as never })));
  assert.match(out, /1\.250 EUR per tonne/);
  assert.match(out, /0\.875 kg/);
  assert.doesNotMatch(out, /density 0\.412|scores 0\.731/);
});

test("INV-272 a status token is drawn in words, an unknown one in none", () => {
  assert.deepEqual([statusWord("HYPOTHESIS"), statusWord("CONFIRMED"), statusWord("REFUTED"), statusWord("SOMETHING"), statusWord(null)], ["Hypothesis", "Confirmed", "Refuted", null, null]);
});

test("I16 a browser-client failure reaches the page as the table's sentence for its class, never the driver's text, a constraint or a code", () => {
  const logged: unknown[][] = [];
  const warn = log.warn;
  log.warn = (...a: Parameters<typeof log.warn>) => void logged.push(a);
  try {
    assert.equal(readFailure({ message: 'duplicate key value violates unique constraint "profiles_pkey"', code: "23505" }), DB_SENTENCES["409"]);
    assert.equal(readFailure({ message: "canceling statement due to statement timeout", code: "57014" }), DB_SENTENCES["503"]);
    assert.equal(readFailure({ message: "permission denied for table secret", code: "42501" }), DB_SENTENCES["403"]);
    assert.equal(readFailure({ message: "boom" }), DB_SENTENCES["500"]);
  } finally {
    log.warn = warn;
  }
  assert.equal(logged.length, 4, "the driver's message is logged, once per failure");
  assert.ok(logged.every((l) => /database/.test(String(l[0]))));
});
