// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 33-101)
// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 129-155)
// The free theme-brief seam: a session authors a theme brief from a bundle, and this writes the theme_briefs row stamped with its batch. It accepts ONE thing: a ValidThemeBrief, the value
// parseThemeBriefEntry returns after validateThemeBriefEntry passed against the theme's LIVE material (sections, claims, figures, ramifications). The old seam validated only the member hash and let a
// brief authored as a single JSON or markdown payload write unvalidated text to customers; that route is gone, a single payload is turned into an entry and validated like any other (apply.ts).
// The write is ONE database call (apply_theme_brief, migration 0075): it locks the theme row, recomputes the member hash from it, refuses a stale or dissolved theme (INV-191) and upserts, the replaced brief
// kept by the theme_brief_versions trigger in the same transaction. No model is called here.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { isSupersededBrief, SUPERSEDED_PREFIX } from "@/core/flywheel/themes";
import { isValidThemeBrief, type ValidThemeBrief } from "@/core/briefs/theme-brief-contract";
import type { RunResult } from "@/core/sources/run-result";

export interface SeamDeps {
  sb: Db;
  now: () => Date;
}
/** Write (unless dry) one validated brief under `batch`. Anything that is not a ValidThemeBrief is refused before the database is touched. */
export async function applyThemeBrief(deps: SeamDeps, input: { brief: ValidThemeBrief; batch: string; dry: boolean }): Promise<RunResult> {
  const { brief } = input;
  if (!isValidThemeBrief(brief)) return { counts: { refused: 1 }, outcome: "failed", notes: ["the brief did not come from parseThemeBriefEntry: only a validated entry is written"] };
  if (input.dry) return { counts: { valid: 1 }, outcome: "ok", notes: ["dry: brief valid, nothing written"] };
  const { data, error } = await deps.sb.rpc("apply_theme_brief", { p_theme_id: brief.theme_id, p_member_hash: brief.member_hash, p_title: brief.title, p_brief_md: brief.brief_md, p_sections: brief.sections, p_claims: brief.claims, p_generated_by: input.batch, p_now: deps.now().toISOString() });
  if (error) return { counts: { refused: 1 }, outcome: "failed", notes: [`theme_briefs not written: ${error.message}`] };
  const res = data as { member_count?: number } | null;
  return { counts: { written: 1, members: res?.member_count ?? 0 }, outcome: "ok", notes: [] };
}

/** retire-orphan-theme-briefs: a theme_briefs row whose theme_id is absent from connection_themes describes a theme the corpus pass dissolved. It is marked superseded (generated_by gains SUPERSEDED_PREFIX; theme_briefs has no status column) by UPDATE, so the migration 0039 trigger keeps the prior row. Idempotent: a marked row is not touched again. Dry reports the ids. */
export async function retireOrphanThemeBriefs(deps: SeamDeps, input: { dry: boolean }): Promise<RunResult> {
  const live = new Set((await fetchAllRows<{ id: string }>((from, to) => deps.sb.from("connection_themes").select("id").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 })).map((t) => t.id));
  const briefs = await fetchAllRows<{ theme_id: string; generated_by: string }>((from, to) => deps.sb.from("theme_briefs").select("theme_id, generated_by").order("theme_id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  const orphans = briefs.filter((b) => !live.has(b.theme_id) && !isSupersededBrief(b));
  const ids = orphans.map((b) => b.theme_id);
  const counts = { orphans: orphans.length, already_superseded: briefs.filter((b) => !live.has(b.theme_id) && isSupersededBrief(b)).length };
  if (input.dry || !orphans.length) return { counts, outcome: "ok", notes: [input.dry ? `dry: ${orphans.length} orphan brief(s) would be superseded: ${ids.join(", ")}` : "no orphan briefs"] };
  let retired = 0;
  for (const b of orphans) {
    const up = await deps.sb.from("theme_briefs").update({ generated_by: `${SUPERSEDED_PREFIX}${b.generated_by}` }).eq("theme_id", b.theme_id).eq("generated_by", b.generated_by).select("theme_id");
    if (up.error) return { counts: { ...counts, retired }, outcome: "failed", notes: [`theme_briefs update failed for ${b.theme_id}: ${up.error.message}`] };
    retired += up.data?.length ?? 0;
  }
  return { counts: { ...counts, retired }, outcome: retired === orphans.length ? "ok" : "partial", notes: [`${retired} of ${orphans.length} orphan brief(s) superseded: ${ids.join(", ")}`] };
}
