// R2d, I8: a failed read is drawn as a stated refusal, never as a value. INV-R2d-1: every fixed page, drawn once per failed read, says so and prints no number or list in the failed read's place; INV-R2d-5 lives in
// tests/derived/masthead.test.ts. Each case first reproduces the register row's wrong output.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReactNode } from "react";

import { STATED } from "../_support/page-sweep.ts";
import { renderApp, textOf } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

const drawn = async (path: string, render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path }));
const regulation = (n: number) => ({ id: `ffffffff-0000-4000-8000-${String(n).padStart(12, "0")}`, legacy_id: `reg-${n}`, title: `Regulation ${n}`, item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, priority: "MODERATE", origin_class: "official", added_date: "2026-10-01" });

test("surfaces:2 the counts RPC failing on a full first page never prints the 60 rows as the whole list: the dek says the list is longer, and the page still asks for the rest", async () => {
  const w = memberWorld();
  w.db.seed("intelligence_items", Array.from({ length: 75 }, (_, i) => regulation(i + 1)));
  w.failRpc("get_surface_counts");
  const text = await drawn("/regulations", async () => (await import("@/features/regulations/pages")).RegulationsIndex());
  assert.match(text, STATED);
  assert.doesNotMatch(text, /\b\d+ active\b/, "the first page is not the list");
  assert.match(text, /\d+ shown, the list is longer/);
  const { readRegulationsFirstPage } = await import("@/features/regulations/list-read");
  const first = await readRegulationsFirstPage((await import("../_support/fake-clients.ts")).scripted.user!() as never, "11111111-1111-4111-8111-111111111111");
  assert.equal(first.aggregates, null);
  assert.equal(first.hasMore, true, "a full page with no total is not the end of the list");
});

test("surfaces:2 a short list with failed counts is still the whole list: the count is printed, with the failure stated beside it", async () => {
  const w = memberWorld();
  w.failRpc("get_surface_counts");
  const text = await drawn("/regulations", async () => (await import("@/features/regulations/pages")).RegulationsIndex());
  assert.match(text, STATED);
  assert.match(text, /\b2 active\b/);
});

test("surfaces:32 the profile reads the region roster once, and a failed roster read fails the page (Retry), never an empty roster that resolves no region", async () => {
  const route = async () => (await import("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) });
  const healthy = memberWorld();
  healthy.db.seed("regions", [{ id: "rg1", code: "EU", label: "European Union", display_order: 1, iso_codes: ["EU"] }]);
  await drawn("/operations/o1", route);
  assert.equal(healthy.db.reads("regions").length, 1, "one roster read for the profile");
  const refused = memberWorld();
  refused.failTable("regions");
  await assert.rejects(route(), /refused by the page sweep/);
});

test("surfaces:1 and 38 the Watch control is live or absent, never dead: the kit's provider-less ItemWatch is used nowhere in the features, and a membership read that failed is a stated failure with Retry, not a disabled control that looks unwatched", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []; });
  assert.deepEqual(walk("src/features").filter((f) => /^import[^\n]*\bItemWatch\b/m.test(readFileSync(f, "utf8"))), [], "ItemWatch reads a context nothing provides");
  const { createElement } = await import("react");
  const { DetailWatch } = await import("@/features/workspace/ui/DetailWatch");
  const { loadMembership, resetMembership } = await import("@/features/watchlist/membership");
  resetMembership();
  await loadMembership("reg", (async () => { throw new Error("down"); }) as never);
  const failed = textOf(renderApp(createElement(DetailWatch, { type: "reg", id: "o3" })));
  assert.match(failed, /Watch status did not load/);
  assert.match(failed, /Retry/);
  resetMembership();
});
