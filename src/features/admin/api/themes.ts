// Ported from old_repo/src/app/api/admin/themes/route.ts (lines 7-85)
import { boundedRead, rowsByIds } from "@/core/db";
import { computeThemeStats, convergenceBand, isBriefStale } from "@/core/flywheel";
import { LookupError } from "@/core/http/errors";

import { adminRoute, boundedInt, reply } from "./shared";

interface ThemeRow {
  id: string;
  computed_at: string;
  member_ids: string[];
  dominant_signals: unknown;
  surfaces: string[] | null;
  density: number | null;
  convergence: number | null;
  pivots: unknown;
}

/** Connection themes strongest first with their durable brief (stale when the live membership moved), the stats and the last run. A failed brief or run read is an error, not an absence. */
export const GET = adminRoute("/api/admin/themes", async (admin, request) => {
  const limit = boundedInt(new URL(request.url).searchParams.get("limit"), 50, 200);
  const db = admin.service();
  const themes = await boundedRead<ThemeRow>((n) => db.from("connection_themes").select("id, computed_at, member_ids, dominant_signals, surfaces, density, convergence, pivots").order("convergence", { ascending: false }).order("id", { ascending: true }).limit(n), { limit });
  if (themes.error) throw new LookupError("connection_themes", themes.error);
  const briefs = await rowsByIds<{ theme_id: string; title: string; brief_md: string; generated_at: string; member_hash: string }>(db, "theme_briefs", "theme_id, title, brief_md, generated_at, member_hash", themes.data.map((t) => t.id), "theme_id", "theme_id");
  const byTheme = new Map(briefs.map((b) => [b.theme_id, b]));
  const run = await boundedRead<Record<string, unknown>>((n) => db.from("connection_theme_runs").select("id, started_at, finished_at, status, nodes_read, edges_read, nodes_clustered, edges_used, themes_written, gaps_flagged, rounds").order("started_at", { ascending: false }).limit(n), { limit: 1 });
  if (run.error) throw new LookupError("connection_theme_runs", run.error);
  const withBrief = themes.data.map((t) => {
    const b = byTheme.get(t.id);
    return { ...t, band: convergenceBand(t.convergence), brief: b ? { title: b.title, brief_md: b.brief_md, generated_at: b.generated_at, stale: isBriefStale(b.member_hash, t.member_ids) } : null };
  });
  return reply(admin, { themes: withBrief, stats: computeThemeStats(themes.data), last_run: run.data[0] ?? null, params: { limit } });
});
