// Ported from old_repo/scripts/research/backfill-themes.mjs (lines 28-66)
// The free replacement of the theme backfill's model call: keyword rules per theme over the closed seven-theme vocabulary. A finding that matches exactly one theme best is
// classified; a tie, or no match, stays `unclassified` (the honest band the Research cards render) and is the residue the `theme-classification` drain kind exports
// for a session to author. Never a forced pick (rule 2).
import { z } from "zod";

import raw from "./data/theme-rules.json";

const rules = z.object({ themes: z.record(z.string(), z.array(z.string()).min(1)), minMatches: z.number().int().min(1) }).parse(raw);
export const THEME_VALUES: readonly string[] = Object.freeze(Object.keys(rules.themes));
export const UNCLASSIFIED = "unclassified";
const COMPILED = Object.entries(rules.themes).map(([theme, ps]) => ({ theme, res: ps.map((p) => ({ p, re: new RegExp(p, "i") })) }));

export interface ThemeVerdict { theme: string; matched: string[]; reason: "single-best" | "no-match" | "tie" | "below-minimum" }
/** The theme with strictly the most distinct matching rules (at least minMatches); a tie or no match is `unclassified` with its reason. */
export function classifyTheme(text: string | null | undefined): ThemeVerdict {
  const body = String(text ?? "");
  const scored = COMPILED.map((c) => ({ theme: c.theme, matched: c.res.filter((r) => r.re.test(body)).map((r) => r.p) })).filter((s) => s.matched.length > 0).sort((a, b) => b.matched.length - a.matched.length || a.theme.localeCompare(b.theme));
  const top = scored[0];
  if (!top) return { theme: UNCLASSIFIED, matched: [], reason: "no-match" };
  if (top.matched.length < rules.minMatches) return { theme: UNCLASSIFIED, matched: top.matched, reason: "below-minimum" };
  if (scored[1] && scored[1].matched.length === top.matched.length) return { theme: UNCLASSIFIED, matched: top.matched, reason: "tie" };
  return { theme: top.theme, matched: top.matched, reason: "single-best" };
}

/** Rows of null-theme findings split into classified (theme to write) and residue (to the drain). */
function classifyThemes(rows: ReadonlyArray<{ id: string; title?: string | null; text?: string | null }>) {
  const classified: Array<{ id: string; theme: string; matched: string[] }> = [];
  const residue: Array<{ id: string; reason: ThemeVerdict["reason"] }> = [];
  for (const r of rows) {
    const v = classifyTheme(`${r.title ?? ""} ${r.text ?? ""}`);
    if (v.theme === UNCLASSIFIED) residue.push({ id: r.id, reason: v.reason });
    else classified.push({ id: r.id, theme: v.theme, matched: v.matched });
  }
  return { classified, residue };
}
