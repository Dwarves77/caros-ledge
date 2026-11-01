// PRODUCER-CAPTURE-1: every weekly Oil Bulletin observation of a ratified series is filed as a capture (a sheet row rendered by the declared xlsx-row-text transform) a brief can quote verbatim.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { groundBrief, isUsableCapture, readPool } from "@/core/grounding";
import { runProducer } from "@/core/producers/runner";
import { createMethodRegistry, registerMarketMethods } from "@/core/propagation";
import { exportBatch } from "@/features/batches";
import { computeSeriesDeltas } from "@/features/market/lib/deltas";
import { euOilBulletin } from "@/features/market/producers/eu-oil-bulletin";
import { afterMarketWrite, type SeriesCapture } from "@/features/market/producers/market-series-delta";

import { installPropagationRpcs } from "../_support/memdb.ts";
import { batchWorld, factClaim, ITEM, NOW } from "../batches/world.ts";

import { makeDeps, xlsx } from "./support.ts";

const day = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;
const bulletin = () =>
  xlsx("Prices wo taxes", [
    [null, "EU_price_wo_tax_euro95", "EU_price_wo_tax_diesel"],
    ["Date", "Euro-Super 95", "Automotive gas oil"],
    [null, null, null],
    [day("2026-10-12"), 1500.5, 1400],
    [day("2026-10-05"), 1490, null],
  ]);
const SENTENCE = "Weekly Oil Bulletin, week of 2026-10-12. Euro-Super 95, EU average, before taxes: 1500.5 EUR/1000L.";
const DIESEL = "eu-oil-bulletin:automotive-diesel";
const EURO = "eu-oil-bulletin:eurosuper-95";
const EC = "b0000000-0000-4000-8000-0000000000ec";

const world = () => {
  const w = batchWorld({ itemType: "market_signal", pool: [] });
  installPropagationRpcs(w.db);
  w.db.seed("sources", [{ id: EC, name: "European Commission, Energy", url: "https://energy.ec.europa.eu/", base_tier: 1, tier_override: null, status: "active" }]);
  w.db.seed("market_series_items", [{ series_key: EURO, item_id: ITEM, status: "ratified" }, { series_key: DIESEL, item_id: ITEM, status: "ratified" }]);
  const registry = createMethodRegistry();
  registerMarketMethods(registry, { carbonIntensity: () => ({ ok: false, reason: "n/a" }), computeSeriesDeltas: computeSeriesDeltas as never });
  const d = makeDeps({ db: { db: w.db.client } as never, env: { MARKET_PRODUCER_EU_OIL_BULLETIN_ENABLED: "1" } });
  const run = (dry: boolean) => runProducer(Object.assign(d.deps, { market: { registry, computeSeriesDeltas } }) as never, { spec: euOilBulletin, dry, bytes: bulletin(), since: "2000-01-01" });
  const captures = () => w.db.rows("agent_run_searches").filter((r) => r.transform === "xlsx-row-text");
  return { w, run, captures };
};

test("INV-PC-1/2: a ratified series' weekly rows file one capture per (item, week) with the exact transform text; a second run files 0; a dry run files 0 and names the candidates", async () => {
  const { w, run, captures } = world();
  const dry = await run(true);
  assert.equal(dry.outcome, "ok", dry.notes.join("|"));
  assert.equal(dry.counts.captures_candidate, 3, "two products in the newest week, one in the earlier week");
  assert.equal(captures().length, 0, "a dry run files nothing");
  const first = await run(false);
  assert.equal(first.outcome, "ok", first.notes.join("|"));
  assert.equal(first.counts.created, 3);
  assert.equal(first.counts.captures_filed, 3);
  const rows = captures();
  assert.deepEqual(rows.map((r) => [r.intelligence_item_id, r.search_query, r.transform_version, r.capture_channel, r.number_locale]).sort(), [
    [ITEM, `series:${DIESEL}@2026-10-12`, "1.0.0", "direct", "en"],
    [ITEM, `series:${EURO}@2026-10-05`, "1.0.0", "direct", "en"],
    [ITEM, `series:${EURO}@2026-10-12`, "1.0.0", "direct", "en"],
  ]);
  assert.equal(rows.find((r) => r.search_query === `series:${EURO}@2026-10-12`)?.result_content, SENTENCE, "one sentence, the cell text as the sheet shows it");
  assert.equal(rows.find((r) => r.search_query === `series:${DIESEL}@2026-10-12`)?.result_content, "Weekly Oil Bulletin, week of 2026-10-12. Automotive gas oil / diesel, EU average, before taxes: 1400 EUR/1000L.");
  const before = JSON.stringify(rows.map((r) => r.result_content));
  const again = await run(false);
  assert.equal(again.outcome, "ok", again.notes.join("|"));
  assert.equal(again.counts.captures_filed, 0);
  assert.equal(again.counts.captures_already, 3);
  assert.equal(captures().length, 3);
  assert.equal(JSON.stringify(captures().map((r) => r.result_content)), before, "byte-identical across runs");
  const old = [{ series_key: EURO, reference_period: "2026-10-12", as_at_date: "2026-10-12", source_ref: "x" }];
  const dryCtx = { sb: w.db.client, deps: { market: { registry: createMethodRegistry(), computeSeriesDeltas } }, input: {}, now: () => NOW, apply: false, state: { seriesCaptures: new Map<string, SeriesCapture>([[`series:${EURO}@2026-10-12`, { url: "https://x.invalid/f", text: "changed", locale: "en" }]]) } };
  const planned = await afterMarketWrite(dryCtx as never, { rows: old, created: [], updated: [] });
  assert.deepEqual([planned.captures_planned, planned.captures_filed], [1, 0], "dry plans the update and writes nothing");
  assert.equal(captures().find((r) => r.search_query === `series:${EURO}@2026-10-12`)?.result_content, SENTENCE);
});

test("a series with no ratified item files no capture (the sheet row alone has no brief to quote it)", async () => {
  const { w, run, captures } = world();
  w.db.rows("market_series_items").forEach((r) => (r.status = "pending"));
  const r = await run(false);
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.captures_filed, 0);
  assert.equal(captures().length, 0);
});

test("INV-PC-4: rows changed for a ratified series with no capture filed or held fails the after-hook closed; nothing changed, or no ratified item, does not", async () => {
  const { w } = world();
  const ctx = (series: string) => ({ sb: w.db.client, deps: { market: { registry: createMethodRegistry(), computeSeriesDeltas } }, input: {}, now: () => NOW, apply: true, state: { seriesCaptures: new Map() }, series });
  const rows = (series: string) => [{ series_key: series, reference_period: "2025-01-06", as_at_date: "2025-01-06", source_ref: "x" }];
  await assert.rejects(afterMarketWrite(ctx(EURO) as never, { rows: rows(EURO), created: rows(EURO), updated: [] }), /assertCapturesFiled: this run wrote 1 row/);
  assert.equal((await afterMarketWrite(ctx(EURO) as never, { rows: rows(EURO), created: [], updated: [] })).captures_filed, 0, "no row changed");
  assert.equal((await afterMarketWrite(ctx("eu-oil-bulletin:lpg-motor-fuel") as never, { rows: rows("eu-oil-bulletin:lpg-motor-fuel"), created: rows("eu-oil-bulletin:lpg-motor-fuel"), updated: [] })).captures_filed, 0, "no ratified item");
});

test("INV-PC-3: the item's pool and its brief packet carry the weekly sentences, and a FACT span quoting the week's value grounds verbatim", async () => {
  const { w, run } = world();
  await run(false);
  const pool = await readPool(w.db.client, ITEM);
  assert.ok(pool.some((p) => p.text === SENTENCE), "a sentence far under the stub floor is still a usable capture");
  const dir = mkdtempSync(join(tmpdir(), "caros-pc-"));
  const r = await exportBatch("item-briefs", w.deps, { outDir: dir, ids: [ITEM] });
  assert.equal(r.outcome, "ok", r.notes.join(";"));
  const part = JSON.parse(readFileSync((r.data as { ids: { parts: string[] } }).ids.parts[0] as string, "utf8")) as { items: { id: string; pool: { text: string }[] }[] };
  assert.ok(part.items.find((i) => i.id === ITEM)?.pool.some((p) => p.text === SENTENCE), "the packet's pool holds the week's sentence");
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: SENTENCE }]);
  const sources = { ...w.deps.intake.sources, resolveSource: (url: string) => (new URL(url).hostname === "energy.ec.europa.eu" ? { tier: 1, institution: "European Commission", sourceId: EC } : w.deps.intake.sources.resolveSource(url)) };
  const captureUrl = String(pool.find((p) => p.text === SENTENCE)?.url);
  const g = await groundBrief({ sb: w.deps.sb, sources, now: () => NOW }, { itemId: ITEM, ledger: [{ ...factClaim(SENTENCE, { section: "1", source_id: EC, source_url: captureUrl }), search_result_id: null }] as never });
  assert.equal(g.dropped, 0, g.detail);
  assert.ok(w.db.rows("section_claim_provenance").some((c) => c.source_span === SENTENCE), "the span is in the ledger");
});

test("the exemption keys on the transform column, not the search text: a fetched wall page named series:x is not usable, the same row with a transform is", () => {
  const wall = `Just a moment... Checking your browser before accessing the site. Enable JavaScript and cookies to continue. Cloudflare Ray ID. ${"x".repeat(240)}`;
  assert.ok(wall.length >= 300);
  const row = { result_content: wall, result_url: "https://energy.ec.europa.eu/x", search_query: "series:x" };
  assert.equal(isUsableCapture({ ...row, transform: null }), false);
  assert.equal(isUsableCapture({ ...row, transform: "xlsx-row-text" }), true);
});
