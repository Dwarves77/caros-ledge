// Ported from old_repo/scripts/turns/run-source-sweep.mjs (lines 156-1004)
// Ported from old_repo/scripts/turns/run-source-sweep.mjs (lines 1113-1209)
// Ported from old_repo/scripts/turns/run-source-sweep.mjs (lines 1219-1360)
// Stage 1, sweep: the walkers (feed, sitemap, the EUR-Lex OJ and Federal Register registers) over the registered sources; every link found lands in the portal ledger.
import { gunzipSync, gzipSync } from "node:zlib";

import { persistPortalCandidates } from "@/features/intake";
import type { FamilyCall } from "@/core/harness";
import { walkEurlexOj, walkFederalRegister } from "@/features/sources/walkers/register";
import { walkFeed } from "@/features/sources/walkers/feed";
import { walkSource, type SitemapDeps, type SitemapUrlEntry } from "@/features/sources/walkers/sitemap";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";

import type { BuiltDeps } from "../wiring";

export interface RegisterWalk {
  register: "eurlex-oj" | "federal-register";
  from: string;
  to: string;
  /** The portal source the links belong to. */
  sourceId: string;
}
export interface SweepPlan {
  sourceIds: string[] | null;
  limit: number;
  registers: RegisterWalk[];
}
const SWEEP_DEFAULT_LIMIT = 25;
const SWEEP_MAX_LIMIT = 200;

/** Validate the stage input into a plan. Pure. */
function planSweep(input: Record<string, unknown>): { plan: SweepPlan; errors: string[] } {
  const errors: string[] = [];
  const ids = Array.isArray(input.sourceIds) ? input.sourceIds.filter((x): x is string => typeof x === "string") : null;
  const limit = typeof input.limit === "number" ? Math.floor(input.limit) : SWEEP_DEFAULT_LIMIT;
  if (limit < 1 || limit > SWEEP_MAX_LIMIT) errors.push(`limit must be 1..${SWEEP_MAX_LIMIT}, got ${limit}`);
  const registers: RegisterWalk[] = [];
  for (const r of Array.isArray(input.registers) ? (input.registers as Record<string, unknown>[]) : []) {
    if ((r.register !== "eurlex-oj" && r.register !== "federal-register") || typeof r.from !== "string" || typeof r.to !== "string" || typeof r.sourceId !== "string") errors.push(`registers entry invalid: ${JSON.stringify(r)}`);
    else registers.push({ register: r.register, from: r.from, to: r.to, sourceId: r.sourceId });
  }
  return { plan: { sourceIds: ids && ids.length ? ids : null, limit, registers }, errors };
}

export interface SweepUnit {
  sourceId: string;
  kind: "feed" | "sitemap" | "register";
  ok: boolean;
  upserted: number;
  failed: number;
  changed: number;
  note: string | null;
}
/** Roll the per-source walks into the stage result. A walk that failed is counted and named; no walk at all is ok with nothing swept. Pure. */
export function shapeSweep(units: readonly SweepUnit[], extra: { planned?: number; errors?: string[] } = {}): RunResult {
  const failed = units.filter((u) => !u.ok).length;
  const counts = { sources_walked: units.length, sources_failed: failed, upserted: units.reduce((n, u) => n + u.upserted, 0), link_failures: units.reduce((n, u) => n + u.failed, 0), change_signals: units.reduce((n, u) => n + u.changed, 0), ...(extra.planned !== undefined ? { planned_sources: extra.planned } : {}) };
  const notes = [...(extra.errors ?? []), ...units.filter((u) => u.note).map((u) => `${u.sourceId}: ${u.note}`)];
  const outcome = failed === 0 && !(extra.errors ?? []).length ? "ok" : failed < units.length ? "partial" : units.length === 0 ? "ok" : "failed";
  return { ...runResult(outcome, counts, notes), data: { ids: { swept_source_ids: units.filter((u) => u.ok).map((u) => u.sourceId) } } };
}

/** The sitemap snapshot store: `sitemap-snapshots/<source_id>/current.json.gz` in the raw_fetches bucket (deliberately not the raw_fetches table). */
function snapshotStore(d: BuiltDeps, sourceId: string) {
  const path = `sitemap-snapshots/${sourceId}/current.json.gz`;
  return {
    async get(): Promise<SitemapUrlEntry[] | null> {
      const { data, error } = await d.sb.storage.from("raw_fetches").download(path);
      if (error || !data) return null;
      return JSON.parse(gunzipSync(Buffer.from(await data.arrayBuffer())).toString("utf8")) as SitemapUrlEntry[];
    },
    async save(entries: SitemapUrlEntry[]): Promise<void> {
      const { error } = await d.sb.storage.from("raw_fetches").upload(path, gzipSync(Buffer.from(JSON.stringify(entries))), { upsert: true, contentType: "application/gzip" });
      if (error) throw new Error(`sitemap snapshot write failed: ${error.message}`);
    },
  };
}

/** A changed lastmod on a URL we hold an item for is a change signal: one monitoring_queue row for the source, which the change stage's reconcile consumes. */
async function recordSignal(d: BuiltDeps, sourceId: string, changed: Array<{ loc: string }>): Promise<number> {
  let held = 0;
  for (const c of changed.slice(0, 50)) {
    const r = await d.sb.from("intelligence_items").select("id").eq("source_url", c.loc).eq("is_archived", false).limit(1);
    if (r.error) throw new Error(`change signal read failed: ${r.error.message}`);
    if ((r.data ?? []).length) held += 1;
  }
  if (!held) return 0;
  const at = d.now().toISOString();
  const { error } = await d.sb.from("monitoring_queue").insert({ source_id: sourceId, scheduled_check: at, priority: "normal", last_result: "updated", change_detected: true, checked_at: at });
  if (error) throw new Error(`change signal write failed: ${error.message}`);
  return held;
}

export async function runSweep(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const { plan, errors } = planSweep(call.input);
  if (errors.length) return runResult("failed", { refused: 1 }, errors);
  let q = d.sb.from("sources").select("id, url, name, rss_feed_url").eq("status", "active").order("id", { ascending: true }).limit(plan.limit);
  if (plan.sourceIds) q = q.in("id", plan.sourceIds);
  const read = await q;
  if (read.error) return runResult("failed", {}, [`sources read failed: ${read.error.message}`]);
  const sources = (read.data ?? []) as { id: string; url: string; name: string; rss_feed_url: string | null }[];
  if (call.dry) return { ...shapeSweep([], { planned: sources.length + plan.registers.length }), notes: [`dry: ${sources.length} source(s) and ${plan.registers.length} register walk(s) planned, nothing fetched`] };
  if (!(await d.gate.refresh())) return runResult("failed", { refused: 1 }, ["fetch gate closed (the scrape cadence is off, or the emergency stop is set): nothing swept"]);

  const units: SweepUnit[] = [];
  const nowIso = d.now().toISOString();
  const persistFor = (sourceId: string) => async (links: Array<{ url: string; anchorText?: string | null }>) => {
    const r = await persistPortalCandidates(d.sb, sourceId, links, nowIso);
    return { upserted: r.upserted, failed: r.failed };
  };
  for (const s of sources) {
    try {
      const persist = persistFor(s.id);
      const store = snapshotStore(d, s.id);
      let changed = 0;
      const sm: SitemapDeps = {
        fetchBytes: d.io.fetchBytes, persist, getPreviousSnapshot: store.get, saveSnapshot: store.save,
        recordChange: async (c) => void (changed += await recordSignal(d, s.id, c)),
      };
      let feedUrl = s.rss_feed_url;
      if (!feedUrl) {
        const found = await walkSource(sm, { baseUrl: s.url, sourceUrl: s.url });
        if (found.kind === "sitemap") {
          units.push(found.ok ? { sourceId: s.id, kind: "sitemap", ok: true, upserted: found.upserted, failed: found.failed, changed, note: found.coverageComplete ? null : "sitemap coverage incomplete" } : { sourceId: s.id, kind: "sitemap", ok: false, upserted: 0, failed: 0, changed, note: found.error });
          continue;
        }
        feedUrl = found.feedUrl;
        const stamp = await d.sb.from("sources").update({ rss_feed_url: feedUrl }).eq("id", s.id);
        if (stamp.error) throw new Error(`rss_feed_url stamp failed: ${stamp.error.message}`);
      }
      const w = await walkFeed({ fetchText: d.io.fetchText, persist }, { feedUrl });
      units.push(w.ok ? { sourceId: s.id, kind: "feed", ok: true, upserted: w.upserted, failed: w.failed, changed: 0, note: null } : { sourceId: s.id, kind: "feed", ok: false, upserted: 0, failed: 0, changed: 0, note: w.error });
    } catch (e) {
      units.push({ sourceId: s.id, kind: "feed", ok: false, upserted: 0, failed: 0, changed: 0, note: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const r of plan.registers) {
    try {
      const persist = persistFor(r.sourceId);
      const w = r.register === "eurlex-oj" ? await walkEurlexOj({ fetchHtml: d.io.fetchText, persist }, { from: r.from, to: r.to }) : await walkFederalRegister({ fetchJson: d.io.fetchJson, persist }, { from: r.from, to: r.to });
      units.push({ sourceId: r.sourceId, kind: "register", ok: true, upserted: w.upserted, failed: w.failed, changed: 0, note: null });
    } catch (e) {
      units.push({ sourceId: r.sourceId, kind: "register", ok: false, upserted: 0, failed: 0, changed: 0, note: e instanceof Error ? e.message : String(e) });
    }
  }
  return shapeSweep(units);
}
