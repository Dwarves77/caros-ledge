// IMP-113: the ratification as a turn op. A series is attached to the item that is its figure (market_series_items) only when a mint reached `minted_verified` for it; this reads the mint artifact (per_item: the series key as
// `id`, the outcome, the minted item id), decides each series with ratifySeriesItemMap (the one rule), checks the item is live and verified, writes the ratified rows, and calls the published-price-statistics producer in the SAME
// run (rule 17: the display rows are what the attachment is for). Called by the `ratify-series-items` op (src/core/turn/ops.ts); writes market_series_items; a dry run plans and writes nothing.
import { isAdmissibleItem, ITEM_ADMISSIBLE_COLUMNS, type ItemAdmissibility } from "@/core/derived/admissible";
import { z } from "zod";

import { boundedRead, type Db } from "@/core/db";
import type { RunResult } from "@/core/types/run-result";
import { runResult, worst } from "@/core/types/run-result";

import { readSeriesItemMap, type SeriesItemEntry } from "./market-series-items";
import { ratifySeriesItemMap } from "./published-price-statistics";

const KEY = /^[a-z0-9]+(?:[:_-][a-z0-9]+)*$/;
const artifactSchema = z.object({ per_item: z.array(z.object({ id: z.string().regex(KEY), outcome: z.string().optional(), item_id: z.string().optional() }).passthrough()).min(1).max(200) }).passthrough();

export interface RatifyDeps {
  sb: Db;
  /** The published-price-statistics producer, run by the caller's own frame (the op passes the turn's producer deps): the downstream of a ratification. */
  downstream(dry: boolean): Promise<RunResult>;
}

export async function ratifySeriesItems(deps: RatifyDeps, input: { artifact: unknown; dry: boolean }): Promise<RunResult> {
  const parsed = artifactSchema.safeParse(input.artifact);
  if (!parsed.success) return runResult("failed", { refused: 1 }, [`ratify-series-items: args.artifact must be the mint artifact {per_item: [{id: <series key>, outcome, item_id}]} (1 to 200 entries): ${parsed.error.issues[0]?.message ?? "invalid"}`]);
  const artifact = parsed.data as { per_item: { id: string; outcome?: string; item_id?: string }[] };
  const keys = [...new Set(artifact.per_item.map((p) => p.id))];
  let table: Awaited<ReturnType<typeof readSeriesItemMap>>;
  try {
    table = await readSeriesItemMap(deps.sb);
  } catch (e) {
    return runResult("failed", { read_failed: 1 }, [`ratify-series-items: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const stored = new Map(table);
  // A series the table does not hold yet may be attached only if it has observations (market_series): the attachment is for a figure that exists.
  const unknown = keys.filter((k) => !stored.has(k));
  const seen = new Set<string>();
  if (unknown.length) {
    const probes = await Promise.all(unknown.map(async (k) => ({ k, r: await deps.sb.from("market_series").select("series_key").eq("series_key", k).limit(1) })));
    const bad = probes.find((p) => p.r.error);
    if (bad?.r.error) return runResult("failed", { read_failed: 1 }, [`ratify-series-items: market_series could not be read: ${bad.r.error.message}`]);
    for (const p of probes) if ((p.r.data ?? []).length) seen.add(p.k);
  }
  const raw: Record<string, SeriesItemEntry> = {};
  for (const k of keys) {
    const held = stored.get(k);
    if (held) raw[k] = held;
    else if (seen.has(k)) raw[k] = { item_id: null, status: "pending" };
  }
  const { dispositions } = ratifySeriesItemMap(raw, artifact);
  const reasons = new Map<string, string>(dispositions.filter((d) => d.action === "skipped").map((d) => [d.series_key, d.reason ?? "skipped"]));
  for (const k of unknown.filter((x) => !seen.has(x))) reasons.set(k, "no_observations_in_market_series");
  const wanted = dispositions.filter((d) => d.action === "ratified");
  const itemIds = [...new Set(wanted.map((d) => d.item_id as string))];
  const live = new Set<string>();
  if (itemIds.length) {
    const r = await boundedRead<{ id: string } & ItemAdmissibility>((limit) => deps.sb.from("intelligence_items").select(`id, ${ITEM_ADMISSIBLE_COLUMNS}`).in("id", itemIds).limit(limit), { limit: 200 });
    if (r.error) return runResult("failed", { read_failed: 1 }, [`ratify-series-items: intelligence_items could not be read: ${r.error.message}`]);
    for (const i of r.data) if (isAdmissibleItem(i)) live.add(i.id);
  }
  const ratify = wanted.filter((d) => live.has(d.item_id as string));
  for (const d of wanted.filter((x) => !live.has(x.item_id as string))) reasons.set(d.series_key, "item_not_live_verified");
  let written = 0;
  const failures: string[] = [];
  if (!input.dry) {
    for (const d of ratify) {
      const { error } = await deps.sb.from("market_series_items").upsert({ series_key: d.series_key, item_id: d.item_id, status: "ratified" }, { onConflict: "series_key" });
      if (error) failures.push(`${d.series_key}: ${error.message}`);
      else written += 1;
    }
  }
  const after = await deps.downstream(input.dry);
  const counts = { artifact_entries: keys.length, ratified: input.dry ? 0 : written, would_ratify: input.dry ? ratify.length : 0, skipped: reasons.size, write_failures: failures.length, ...Object.fromEntries(Object.entries(after.counts).map(([k, v]) => [`downstream_${k}`, v])) };
  const notes = [
    ...[...reasons].map(([k, why]) => `${k}: skipped (${why})`),
    ...failures.map((f) => `write failed: ${f}`),
    ...after.notes.map((n) => `[published-price-statistics] ${n}`),
  ];
  return runResult(worst(failures.length ? "partial" : "ok", after.outcome === "failed" ? "partial" : "ok"), counts, notes);
}
