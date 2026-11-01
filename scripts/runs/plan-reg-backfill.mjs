// REG-BACKFILL-1: `node scripts/runs/plan-reg-backfill.mjs [--date 2026-11-01] [--out-ids <file>]` reads the regulation backlog (SELECTs only, through regulationBackfillCandidates) and writes, per batch of 25 ids,
// scripts/runs/plans/data/<date>-reg-backfill-<n>.ids.json and the plan scripts/runs/plans/<date>-reg-backfill-<n>.json (dry then apply over the same bundle file, on_failure stop). The bundle
// data/<date>-reg-backfill-<n>.items.json does not exist until a drain session writes it (author lane, judge lane, ruling 60); until then execute.mjs reports the steps as bundle_missing. The heal candidates
// (no usable capture) are written to --out-ids, never into a plan. Content is never authored here.
import { mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

/** A drain reader's packet budget for item-briefs: itemBriefsExporter bundles each item's whole usable pool and takes `ids`/`limit` (no charBudget), so a batch is bounded by the count of items. */
export const BATCH = 25;
const ruling = (n, date) => `coordinator ${date} (REG-BACKFILL-1 batch ${n}): the reader-authored what_is_it / why_matters / what_it_changes of 25 verified regulations through the item-briefs kit; the author lane and the independent judge lane (ruling 60) wrote the bundle from each item's own capture pool, and the judge verdicts ride in each entry's review; nothing is fetched, so no scrape cadence is exercised and rule 16 stands`;

/** The batches of `ids`: disjoint slices of `size`, each with its ids file body and plan (pure). Names carry the batch number. */
export function batchPlans(ids, { date, size = BATCH, first = 1 }) {
  return Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => {
    const n = first + i;
    const slice = ids.slice(i * size, (i + 1) * size);
    const base = `${date}-reg-backfill-${n}`;
    const bundle = `data/${base}.items.json`;
    const step = (name, mode) => ({ name: `reg-backfill-${n}-${name}`, stage: "briefs", mode, input_file: bundle, producer_env: [], on_failure: "stop" });
    return { n, base, ids: { batch: n, kind: "item-briefs", ids: slice }, plan: { ruling: ruling(n, date), steps: [step("dry", "dry"), step("items", "apply")] } };
  });
}

if (isMain(import.meta.url)) {
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { values } = parseArgs({ options: { date: { type: "string", default: "2026-11-01" }, "out-ids": { type: "string" }, first: { type: "string", default: "1" } }, strict: true });
  const { serviceClient } = await import("../../src/core/db/index.ts");
  const { regulationBackfillCandidates } = await import("../../src/features/batches/kinds/item-briefs/candidates.ts");
  const page = await regulationBackfillCandidates(serviceClient(), { limit: Number.POSITIVE_INFINITY });
  const batches = batchPlans(page.candidates.map((c) => c.id), { date: values.date, first: Number(values.first) });
  mkdirSync("scripts/runs/plans/data", { recursive: true });
  for (const b of batches) {
    writeFileSync(join("scripts/runs/plans/data", `${b.base}.ids.json`), `${JSON.stringify(b.ids, null, 1)}\n`);
    writeFileSync(join("scripts/runs/plans", `${b.base}.json`), `${JSON.stringify(b.plan, null, 2)}\n`);
  }
  if (values["out-ids"]) writeFileSync(values["out-ids"], `${JSON.stringify(page.heal_candidates)}\n`);
  console.log(JSON.stringify({ backlog: page.backlog, authorable: page.candidates.length, heal_candidates: page.heal_candidates.length, batches: batches.length }));
}
