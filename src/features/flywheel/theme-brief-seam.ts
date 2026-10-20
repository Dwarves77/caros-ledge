// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 33-101)
// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 129-155)
// The free theme-brief seam: a session authors a theme brief from a bundle, and this writes the theme_briefs row stamped with its batch. It accepts ONE thing: a ValidThemeBrief, the value
// parseThemeBriefEntry returns after validateThemeBriefEntry passed against the theme's LIVE material (sections, claims, figures, ramifications). The old seam validated only the member hash and let a
// brief authored as a single JSON or markdown payload write unvalidated text to customers; that route is gone, a single payload is turned into an entry and validated like any other (apply.ts).
// The write is ONE database call (apply_theme_brief, migration 0075): it locks the theme row, recomputes the member hash from it, refuses a stale or dissolved theme (INV-191) and upserts, the replaced brief
// kept by the theme_brief_versions trigger in the same transaction. No model is called here.
import type { Db } from "@/core/db";
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
