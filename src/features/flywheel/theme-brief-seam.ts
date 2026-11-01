// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 33-101)
// Ported from old_repo/scripts/connections/generate-theme-brief.mjs (lines 129-155)
// The free theme-brief seam: a session authors a theme brief from a bundle, and this writes the theme_briefs row stamped with its batch. It accepts ONE thing: a ValidThemeBrief, the value
// parseThemeBriefEntry returns after validateThemeBriefEntry passed against the theme's LIVE material (sections, claims, figures, ramifications). The old seam validated only the member hash and let a
// brief authored as a single JSON or markdown payload write unvalidated text to customers; that route is gone, a single payload is turned into an entry and validated like any other (apply.ts).
// The write is ONE database call (apply_theme_brief, migration 0075): it locks the theme row, recomputes the member hash from it, refuses a stale or dissolved theme (INV-191) and upserts, the replaced brief
// kept by the theme_brief_versions trigger in the same transaction. No model is called here.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
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

/** retire-orphan-theme-briefs: a theme_briefs row whose theme_id is absent from connection_themes describes a theme the corpus pass dissolved. It gets superseded_at = now by UPDATE (migration 0148; the 0039 trigger keeps the prior row) and no reader attaches it again. Idempotent: only rows with superseded_at NULL are touched. Dry reports the ids. `liveIds` names the theme set to measure against when connection_themes is not yet (or no longer) the set that counts: the corpus pass in a dry run passes its NEW ids. */
export async function retireOrphanThemeBriefs(deps: SeamDeps, input: { dry: boolean; liveIds?: ReadonlySet<string> }): Promise<RunResult> {
  const live = input.liveIds ?? new Set((await fetchAllRows<{ id: string }>((from, to) => deps.sb.from("connection_themes").select("id").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 })).map((t) => t.id));
  const open = await fetchAllRows<{ theme_id: string }>((from, to) => deps.sb.from("theme_briefs").select("theme_id").is("superseded_at", null).order("theme_id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  const ids = open.map((b) => b.theme_id).filter((id) => !live.has(id));
  const counts = { orphans: ids.length };
  if (input.dry || !ids.length) return { counts, outcome: "ok", notes: [input.dry ? `dry: ${ids.length} orphan brief(s) would be superseded: ${ids.join(", ")}` : "no orphan briefs"] };
  let retired = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const up = await deps.sb.from("theme_briefs").update({ superseded_at: deps.now().toISOString() }).in("theme_id", ids.slice(i, i + 100)).is("superseded_at", null).select("theme_id");
    if (up.error) return { counts: { ...counts, retired }, outcome: "failed", notes: [`theme_briefs update failed: ${up.error.message}`] };
    retired += up.data?.length ?? 0;
  }
  return { counts: { ...counts, retired }, outcome: retired === ids.length ? "ok" : "partial", notes: [`${retired} of ${ids.length} orphan brief(s) superseded: ${ids.join(", ")}`] };
}
