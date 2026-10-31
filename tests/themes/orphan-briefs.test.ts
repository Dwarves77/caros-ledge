// THEME-CODE-1: a theme brief whose theme_id is no longer in connection_themes describes a dissolved theme. The readers (the page view and the export) never attach it, whatever the member overlap, and the retire-orphan-theme-briefs
// op sets its superseded_at by UPDATE (migration 0146; the 0039 trigger keeps the prior row), dry or apply, idempotent. A retired row is not attached either, and a theme with no brief under its own id needs one.
import assert from "node:assert/strict";
import { test } from "node:test";

import { themesNeedingBrief, type StoredBrief } from "@/core/briefs/theme-brief-material";
import { computeMemberHash, resolveBriefForTheme } from "@/core/flywheel/themes";
import type { FamilyCall } from "@/core/harness";
import { themeAnalysisView, themeChips } from "@/core/themes/theme-view";
import { runOps } from "@/core/turn";

import { fixture } from "../integration/world.ts";

const LIVE = "11111111-1111-4111-8111-111111111111";
const DEAD = "22222222-2222-4222-8222-222222222222";
const MEMBERS = ["a", "b", "c"];
const theme = { id: LIVE, member_ids: MEMBERS, surfaces: ["regulations", "market"], convergence: 0.5, pivots: [] };
const items = [
  { id: "a", legacy_id: "a", title: "Item A", item_type: "regulation", domain: 1 },
  { id: "b", legacy_id: "b", title: "Item B", item_type: "market_signal", domain: 2 },
  { id: "c", legacy_id: "c", title: "Item C", item_type: "regulation", domain: 1 },
];
const brief = (theme_id: string, over: Record<string, unknown> = {}) => ({ theme_id, title: `Brief ${theme_id.slice(0, 2)}`, brief_md: "text", member_hash: computeMemberHash(MEMBERS), member_count: 3, generated_at: "2026-10-01T00:00:00Z", generated_by: "theme-briefs-x", sections: null, member_ids: MEMBERS, superseded_at: null, ...over });
const view = (briefs: unknown[]) => themeAnalysisView({ itemId: "a", surface: "regulations", themes: [theme], briefs: briefs as never, members: items, asOfIso: "2026-10-31T00:00:00Z" });

test("a brief whose theme_id is absent from connection_themes is never attached, even when its members are the theme's members", () => {
  const orphan = brief(DEAD);
  assert.deepEqual([view([orphan])?.hasBrief, view([orphan])?.title], [false, null]);
  const chips = themeChips({ themes: [theme], items, briefs: [orphan] as never, surface: null });
  assert.deepEqual([chips[0]?.hasBrief, chips[0]?.stale], [false, false]);
  assert.deepEqual([view([orphan, brief(LIVE)])?.hasBrief, view([orphan, brief(LIVE)])?.title], [true, "Brief 11"], "the brief stored under the theme's own id still attaches");
});

test("a retired brief (superseded_at set) is not attached even under a live theme id", () => {
  const retired = brief(LIVE, { superseded_at: "2026-10-31T00:00:00Z" });
  assert.equal(view([retired])?.hasBrief, false);
  assert.equal(resolveBriefForTheme(theme, [retired as never]).brief, null);
});

test("the export: a theme with no brief under its own id needs one, whatever an orphan overlaps; a retired brief counts as none", () => {
  const live = [{ ...theme, dominant_signals: [], density: 1 }] as never;
  assert.deepEqual(themesNeedingBrief(live, [brief(DEAD)] as StoredBrief[]).map((n) => [n.reason, n.prior]), [["no_brief", null]]);
  assert.deepEqual(themesNeedingBrief(live, [brief(LIVE, { superseded_at: "2026-10-31T00:00:00Z" })] as StoredBrief[]).map((n) => n.reason), ["no_brief"]);
  assert.deepEqual(themesNeedingBrief(live, [brief(LIVE)] as StoredBrief[]), [], "a current brief under its own id needs nothing");
});

const call = (dry: boolean): FamilyCall => ({ mode: dry ? "dry" : "apply", dry, input: { ops: { op: "retire-orphan-theme-briefs" } }, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", upstream: null });
const seed = () => {
  const f = fixture();
  f.db.seed("connection_themes", [{ id: LIVE, member_ids: MEMBERS }]);
  f.db.seed("theme_briefs", [brief(LIVE), brief(DEAD), brief("33333333-3333-4333-8333-333333333333", { superseded_at: "2026-10-01T00:00:00Z" })]);
  return f;
};
const by = (f: ReturnType<typeof fixture>) => Object.fromEntries(f.db.rows("theme_briefs").map((r) => [String(r.theme_id).slice(0, 2), r.superseded_at]));

test("retire-orphan-theme-briefs: dry reports the count and ids and writes nothing; apply sets superseded_at on the orphan only; a second apply writes nothing", async () => {
  const f = seed();
  const dry = await runOps(call(true), f.d);
  assert.equal(dry.notes[0], "op=retire-orphan-theme-briefs");
  assert.deepEqual([dry.outcome, dry.counts.orphans], ["ok", 1]);
  assert.match(dry.notes.join("|"), new RegExp(DEAD));
  assert.deepEqual(by(f), { 11: null, 22: null, 33: "2026-10-01T00:00:00Z" }, "a dry run wrote nothing");
  const applied = await runOps(call(false), f.d);
  assert.deepEqual([applied.outcome, applied.counts.retired], ["ok", 1]);
  const after = by(f);
  assert.deepEqual([after["11"], typeof after["22"], after["33"]], [null, "string", "2026-10-01T00:00:00Z"], "the live theme's brief and an earlier retirement are untouched");
  assert.equal(f.db.rows("theme_briefs").length, 3, "history is kept: nothing deleted");
  const again = await runOps(call(false), f.d);
  assert.deepEqual([again.outcome, again.counts.orphans, again.counts.retired ?? 0], ["ok", 0, 0]);
  assert.equal(by(f)["22"], after["22"], "idempotent: the date is not rewritten");
});
