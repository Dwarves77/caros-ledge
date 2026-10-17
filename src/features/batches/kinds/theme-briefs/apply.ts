// Ported from old_repo/scripts/turns/apply-theme-briefs.mjs (lines 31-118)
// Ported from old_repo/scripts/turns/export-themes-for-briefs.mjs (lines 1-138)
// Theme briefs applied over the free theme-brief seam (P2-06): each entry is validated against the theme's LIVE material (the structured contract: sections, claims, figures), the seam checks the payload against the live
// membership hash (INV-191) and is the one writer of theme_briefs; the structured columns (sections, claims, member_ids) ride the seam's `writeRow`. The stored hash and batch name are read back. A single markdown or
// JSON brief (the seam's own payload) goes through the same seam. A replaced brief's prior row is kept by the AFTER UPDATE trigger on theme_briefs (theme_brief_versions, migration 0039): this writer does nothing for the history. The export is the themes that need a brief (none, stale or superseded), one bundle each within the character budget.
import { computeMemberHash } from "@/core/flywheel/themes";
import { parseFrontmatter } from "@/core/briefs/frontmatter";
import { renderBriefMd, validateThemeBriefEntry, type ThemeContext } from "@/core/briefs/theme-brief-contract";
import { buildThemeBundle, buildValidationContext, computeThemeGaps, loadBriefs, loadLineage, loadThemeMaterial, loadThemes, themesNeedingBrief, type ThemeRow } from "@/core/briefs/theme-brief-material";
import type { Db } from "@/core/db";
import { applyThemeBrief } from "@/features/flywheel";
import { rowsByIds } from "@/core/db";

import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type BatchExport, type EntrySpec } from "../../kit/session-batch";

export const THEME_EXPORT_LIMIT = 15;
const DEFAULT_CHAR_BUDGET = 120_000;
interface ThemeLive { ctx: ThemeContext; themes: Map<string, ThemeRow>; stored: Map<string, { member_hash: string; generated_by: string; brief_md: string }> }
interface Plan { memberIds: string[] }

export const themeBriefsSpec: EntrySpec<ThemeLive, Plan> = {
  kind: "theme-briefs",
  batchRe: /^theme-briefs-[A-Za-z0-9._-]+$/,
  ceiling: 100,
  keyOf: (e) => (typeof e.theme_id === "string" ? e.theme_id : null),
  async load(deps, file) {
    const ids = [...new Set((file.entries as unknown[]).map((e) => (isObj(e) && typeof e.theme_id === "string" ? e.theme_id : "")).filter(Boolean))];
    const themes = await loadThemes(deps.sb, ids);
    const material = await loadThemeMaterial(deps.sb, themes);
    const stored = await rowsByIds<{ theme_id: string; member_hash: string; generated_by: string; brief_md: string }>(deps.sb, "theme_briefs", "theme_id, member_hash, generated_by, brief_md", ids, "theme_id", "theme_id");
    return { ctx: buildValidationContext(themes, material, computeThemeGaps(themes, material)), themes: new Map(themes.map((t) => [t.id, t])), stored: new Map(stored.map((s) => [s.theme_id, s])) };
  },
  entry(e, i, live) {
    const errors = validateThemeBriefEntry(e, i, live.ctx);
    if (errors.length || !isObj(e)) return { errors };
    const id = String(e.theme_id);
    const members = (live.themes.get(id)?.member_ids ?? []).slice().sort();
    const prior = live.stored.get(id);
    return prior && prior.member_hash === computeMemberHash(members) && prior.brief_md === renderBriefMd(e as never) ? { errors: [], done: true } : { errors: [], plan: { memberIds: members } };
  },
  async write(deps, _live, item, batch) {
    const e = item.entry;
    const content = JSON.stringify({ theme_id: e.theme_id, title: String(e.title).trim(), brief_md: renderBriefMd(e as never), member_hash: e.member_hash });
    const r = await applyThemeBrief({ sb: deps.sb, now: deps.now, writeRow: async (row) => {
      const { error } = await deps.sb.from("theme_briefs").upsert({ ...row, generated_by: batch, sections: e.sections, claims: e.claims, member_ids: item.plan.memberIds }, { onConflict: "theme_id" });
      return { error: error ? error.message : null };
    } }, { format: "json", content, dry: false });
    if (r.outcome === "failed" || !r.counts.written) throw new Error(r.notes.join("; ") || "the seam wrote nothing");
    return { ref: String(e.theme_id), counts: { briefs_written: 1 } };
  },
  async readBack(deps, live, written, batch) {
    const stored = new Map((await rowsByIds<{ theme_id: string; member_hash: string; generated_by: string }>(deps.sb, "theme_briefs", "theme_id, member_hash, generated_by", written.map((w) => w.ref), "theme_id", "theme_id")).map((r) => [r.theme_id, r]));
    return written.filter((w) => { const s = stored.get(w.ref); return !s || s.member_hash !== computeMemberHash(live.themes.get(w.ref)?.member_ids ?? []) || s.generated_by !== batch; }).map((w) => w.ref);
  },
};

export const applyThemeBriefBatch = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(themeBriefsSpec, deps, file, o);

/**
 * One theme-briefs apply from the stage's content. A batch file (it has `entries`) goes through the structured batch path; a single brief (the seam's payload: theme_id, title, brief_md, member_hash, as JSON or as markdown
 * with a frontmatter block) goes straight through the seam.
 */
export async function applyThemeBriefs(deps: BatchDeps, input: { content: string; format?: "json" | "md" }, o: ApplyOpts) {
  if (input.format === "md") {
    const fm = parseFrontmatter(input.content);
    const f = fm?.fields ?? {};
    const payload = JSON.stringify({ theme_id: f.theme_id, title: f.title, member_hash: f.member_hash, brief_md: fm?.body });
    return applyThemeBrief({ sb: deps.sb, now: deps.now }, { format: "json", content: fm ? payload : "", dry: o.dry });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch (e) {
    return { counts: { refused: 1 }, outcome: "failed" as const, notes: [`theme-briefs content is not JSON: ${(e as Error).message}`] };
  }
  return isObj(parsed) && Array.isArray(parsed.entries) ? applyThemeBriefBatch(deps, parsed, o) : applyThemeBrief({ sb: deps.sb, now: deps.now }, { format: "json", content: input.content, dry: o.dry });
}

/** The export: themes that need a brief with their bundle. */
export function themeBriefsExporter(sb: Db, o: { charBudget?: number } = {}) {
  return async ({ limit }: { limit: number }): Promise<BatchExport> => {
    try {
      const [themes, briefs, lineage] = [await loadThemes(sb), await loadBriefs(sb), await loadLineage(sb)];
      const needs = themesNeedingBrief(themes, briefs, { lineage });
      const chosen = needs.slice(0, limit);
      const material = await loadThemeMaterial(sb, chosen.map((n) => n.theme));
      const gaps = computeThemeGaps(chosen.map((n) => n.theme), material);
      const items = chosen.map((n) => buildThemeBundle(n, material, gaps.get(n.theme.id), { charBudget: o.charBudget ?? DEFAULT_CHAR_BUDGET }));
      const by = (r: string) => needs.filter((n) => n.reason === r).length;
      return { ok: true, items: items as never, source: { type: "table", table: "connection_themes" }, summary: { themes: themes.length, needing_brief: needs.length, no_brief: by("no_brief"), stale: by("stale"), superseded: by("superseded"), exported: items.length, not_exported_over_limit: needs.length - items.length } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
