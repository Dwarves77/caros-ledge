// THEME-CODE-1: a theme brief whose theme_id is no longer in connection_themes describes a dissolved theme. The reader never attaches it, whatever the member overlap, and the retire-orphan-theme-briefs op marks it
// superseded by UPDATE (theme_briefs has no status column: generated_by gains the "superseded:" prefix, and the migration 0039 trigger keeps the prior row), dry or apply, idempotent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSupersededBrief, resolveBriefForTheme } from "@/core/flywheel/themes";
import type { FamilyCall } from "@/core/harness";
import { computeMemberHash } from "@/core/flywheel/themes";
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
const brief = (theme_id: string, over: Record<string, unknown> = {}) => ({ theme_id, title: `Brief ${theme_id.slice(0, 2)}`, brief_md: "text", member_hash: computeMemberHash(MEMBERS), generated_at: "2026-10-01T00:00:00Z", generated_by: "theme-briefs-x", sections: null, member_ids: MEMBERS, ...over });

test("a brief whose theme_id is absent from connection_themes is never attached, even when its members are the theme's members", () => {
  const orphan = brief(DEAD);
  const view = themeAnalysisView({ itemId: "a", surface: "regulations", themes: [theme], briefs: [orphan], members: items, asOfIso: "2026-10-31T00:00:00Z" });
  assert.deepEqual([view?.hasBrief, view?.title], [false, null]);
  const chips = themeChips({ themes: [theme], items, briefs: [orphan], surface: null });
  assert.deepEqual([chips[0]?.hasBrief, chips[0]?.stale], [false, false]);
  const own = themeAnalysisView({ itemId: "a", surface: "regulations", themes: [theme], briefs: [orphan, brief(LIVE)], members: items, asOfIso: "2026-10-31T00:00:00Z" });
  assert.deepEqual([own?.hasBrief, own?.title], [true, "Brief 11"], "the brief stored under the theme's own id still attaches");
});

test("a retired (superseded) brief is not attached even under a live theme id, and the export treats the theme as having none", () => {
  const retired = brief(LIVE, { generated_by: "superseded:theme-briefs-x" });
  assert.equal(isSupersededBrief(retired), true);
  const view = themeAnalysisView({ itemId: "a", surface: "regulations", themes: [theme], briefs: [retired], members: items, asOfIso: "2026-10-31T00:00:00Z" });
  assert.equal(view?.hasBrief, false);
  assert.deepEqual([resolveBriefForTheme(theme, [retired]).match], [null]);
});

const call = (dry: boolean): FamilyCall => ({ mode: dry ? "dry" : "apply", dry, input: { ops: { op: "retire-orphan-theme-briefs" } }, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", upstream: null });
const seed = () => {
  const f = fixture();
  f.db.seed("connection_themes", [{ id: LIVE, member_ids: MEMBERS }]);
  f.db.seed("theme_briefs", [brief(LIVE), brief(DEAD), brief("33333333-3333-4333-8333-333333333333", { generated_by: "superseded:theme-briefs-old" })]);
  return f;
};
const by = (f: ReturnType<typeof fixture>) => Object.fromEntries(f.db.rows("theme_briefs").map((r) => [String(r.theme_id).slice(0, 2), r.generated_by]));

test("retire-orphan-theme-briefs: dry reports the count and ids and writes nothing; apply marks only the orphan; a second apply writes nothing", async () => {
  const f = seed();
  const dry = await runOps(call(true), f.d);
  assert.equal(dry.notes[0], "op=retire-orphan-theme-briefs");
  assert.deepEqual([dry.outcome, dry.counts.orphans, dry.counts.already_superseded], ["ok", 1, 1]);
  assert.match(dry.notes.join("|"), new RegExp(DEAD));
  assert.deepEqual(by(f), { 11: "theme-briefs-x", 22: "theme-briefs-x", 33: "superseded:theme-briefs-old" }, "a dry run wrote nothing");
  const applied = await runOps(call(false), f.d);
  assert.deepEqual([applied.outcome, applied.counts.retired], ["ok", 1]);
  assert.deepEqual(by(f), { 11: "theme-briefs-x", 22: "superseded:theme-briefs-x", 33: "superseded:theme-briefs-old" }, "the live theme's brief and an earlier retirement are untouched");
  assert.equal(f.db.rows("theme_briefs").length, 3, "history is kept: nothing deleted");
  const again = await runOps(call(false), f.d);
  assert.deepEqual([again.outcome, again.counts.orphans, again.counts.retired ?? 0], ["ok", 0, 0]);
  assert.equal(by(f)["22"], "superseded:theme-briefs-x", "idempotent: the marker is not stacked");
});
