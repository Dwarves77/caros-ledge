import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFrontmatter } from "@/core/briefs/frontmatter";
import { admissibleRows } from "@/core/derived/admissible";
import { figureCoverage, isValidThemeBrief, parseRamifications } from "@/core/briefs/theme-brief-contract";
import { computeMemberHash } from "@/core/flywheel/themes";
import { applyBatch } from "@/features/batches";
import { loadThemeMaterial, loadThemes } from "@/core/briefs/theme-brief-material";
import { themeBriefsExporter } from "@/features/batches/kinds/theme-briefs/apply";

import { batchFile, ITEM, passingReview } from "./world.ts";
import { CLAIM_A, CLAIM_B, EVENT_B, SECOND, THEME, themeWorld, type World } from "./worlds.ts";

/** The second reader's all-pass verdicts on a theme entry. */
const withThemeReview = <T extends Record<string, unknown>>(e: T): T & { review: Record<string, unknown> } => ({ ...e, review: passingReview(e, "theme-briefs") });

const hash = computeMemberHash([SECOND, ITEM]);
/** The stored brief text: the title, then the sections in order under their fixed headings (the format the readers show). */
const HEADINGS: [string, string][] = [["connection", "Connection"], ["meaning", "What it means"], ["ramifications", "Ramifications"], ["watch", "Watch"], ["gaps", "Gaps"]];
const renderBriefMd = (e: { title: string; sections: Record<string, string> }) => {
  const parts = [`# ${e.title.trim()}`, ...HEADINGS.filter(([k]) => (e.sections[k] ?? "").trim()).map(([k, h]) => `## ${h}\n\n${(e.sections[k] ?? "").trim()}`)];
  return `${parts.join("\n\n")}\n`;
};
const entry = (over: Record<string, unknown> = {}) => withThemeReview({
  theme_id: THEME, member_hash: hash, title: "The reporting duty and the surcharge it triggers",
  sections: { connection: "Both items concern the annual reporting duty and how carriers price it.", meaning: "A forwarder should expect the duty to reach the rate card.", ramifications: "### Regulations\nThe duty needs an owner in each operating unit.", watch: "Watch the next dated step.", gaps: "No operations item yet." },
  claims: [{ section: "connection", text: "annual reporting duty", member_id: ITEM, claim_ids: [CLAIM_A] }, { section: "watch", text: "Watch the next dated step.", member_id: SECOND, claim_ids: [EVENT_B] }],
  ...over,
});
const apply = (w: World, entries: unknown[], dry = false) => applyBatch("theme-briefs", w.deps, { content: JSON.stringify(batchFile("theme-briefs", entries)), dry });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const stored = (w: World) => w.db.rows("theme_briefs");

test("a theme brief is validated against the theme's LIVE material, written through the seam with its structured columns, and read back at the live member hash", async () => {
  const w = themeWorld();
  const dry = await apply(w, [entry()], true);
  assert.equal(dry.counts.valid, 1, notes(dry));
  assert.equal(stored(w).length, 0, "a dry run wrote nothing");
  const r = await apply(w, [entry()]);
  assert.equal(r.counts.applied, 1, notes(r));
  assert.equal(r.outcome, "ok", notes(r));
  const row = stored(w)[0] as Record<string, unknown>;
  assert.deepEqual([row.theme_id, row.member_hash, row.generated_by, row.member_count], [THEME, hash, "theme-briefs-001", 2]);
  assert.deepEqual(row.member_ids, [ITEM, SECOND].sort());
  assert.equal(row.brief_md, renderBriefMd(entry() as never));
  assert.equal((row.claims as unknown[]).length, 2);
  const writes = w.db.writes().length;
  const again = await apply(w, [entry()]);
  assert.deepEqual([again.counts.already_applied, again.counts.applied], [1, 0]);
  assert.equal(w.db.writes().length, writes, "a re-apply wrote nothing new");
});

test("INV-191 attack: a brief authored against a stale membership is refused and nothing is written; so are a figure no claim covers, an id in a section and a claim that is not the member's", async () => {
  const w = themeWorld();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["stale hash", { member_hash: "deadbeef" }, /member_hash does not match the live membership/],
    ["uncited figure", { sections: { ...entry().sections, meaning: "The duty costs EUR 900000 per year." } }, /states "900000".*outside any listed claim/],
    ["an id in a section", { sections: { ...entry().sections, meaning: `See ${ITEM} for the duty.` } }, /carries an id/],
    ["a claim of another member", { claims: [{ section: "connection", text: "annual reporting duty", member_id: ITEM, claim_ids: [CLAIM_B] }] }, /is not a grounded claim of member/],
    ["a claim not in its section", { claims: [{ section: "connection", text: "text that is not there", member_id: ITEM, claim_ids: [CLAIM_A] }] }, /does not appear in section "connection"/],
    ["a surface the theme does not span", { sections: { ...entry().sections, ramifications: "### Regulations\nx\n### Operations\ny" } }, /for a surface this theme does not span/],
    ["a missing surface", { sections: { ...entry().sections, ramifications: "Only prose." } }, /text before the first/],
    ["an empty required section", { sections: { ...entry().sections, watch: "" } }, /required section "watch" is empty/],
    ["an unknown theme", { theme_id: "d0000000-0000-4000-8000-0000000000ff" }, /unknown theme/],
  ];
  for (const [name, over, re] of cases) assert.match(notes(await apply(w, [entry(over)])), re, name);
  assert.equal(stored(w).length, 0);
});

test("the export lists the themes that need a brief with their bundle; a stale brief is re-listed after the membership moves; an applied one is not", async () => {
  const w = themeWorld();
  const first = await themeBriefsExporter(w.db.client)({ limit: 5 });
  const b = (first.items as unknown as { theme_id: string; member_hash: string; needs: string; members: { id: string }[]; truncation: { members_included: number } }[])[0];
  assert.deepEqual([b?.theme_id, b?.member_hash, b?.needs, b?.truncation.members_included], [THEME, hash, "no_brief", 2]);
  await apply(w, [entry()]);
  assert.equal((await themeBriefsExporter(w.db.client)({ limit: 5 })).items.length, 0);
  (w.db.rows("connection_themes")[0] as Record<string, unknown>).member_ids = [SECOND];
  const after = (await themeBriefsExporter(w.db.client)({ limit: 5 })).items as unknown as { needs: string }[];
  assert.equal(after[0]?.needs, "stale");
});

test("DIGEST-FIX-1: the export honours an explicit ids filter, and a theme over the budget is refused by name with its member count, never exported with members silently dropped", async () => {
  const w = themeWorld();
  assert.equal((await themeBriefsExporter(w.db.client)({ limit: 5, ids: ["no-such-theme"] })).items.length, 0);
  assert.equal((await themeBriefsExporter(w.db.client)({ limit: 5, ids: [THEME] })).items.length, 1);
  const tiny = await themeBriefsExporter(w.db.client, { charBudget: 700 })({ limit: 5 });
  assert.equal(tiny.items.length, 0, "no bundle with dropped members is handed out");
  assert.match(JSON.stringify(tiny.residue), new RegExp(`${THEME}.*2 member`));
});

test("INV-R2b-5 (F:3): a single payload takes the batch path: an entry that fails validation is refused with the SAME reasons as in a batch, as JSON or markdown, and nothing is written; a valid single entry is written", async () => {
  const w = themeWorld();
  const bad = entry({ sections: { ...entry().sections, meaning: "The duty costs EUR 900000 per year." } });
  const viaBatch = notes(await apply(w, [bad]));
  const single = (content: string, format?: "md") => applyBatch("theme-briefs", w.deps, { content, ...(format ? { format } : {}), dry: false });
  const viaSingle = notes(await single(JSON.stringify(bad)));
  const reason = (s: string) => /section "meaning" states "900000"[^\n]*/.exec(s)?.[0];
  assert.ok(reason(viaBatch), viaBatch);
  assert.equal(reason(viaSingle), reason(viaBatch), "the same refusal on both paths");
  assert.equal((await single(JSON.stringify({ theme_id: THEME, title: "T", brief_md: "body", member_hash: hash }))).outcome, "failed", "the old four-field payload carries no sections or claims and is refused");
  const md = `---\ntheme_id: ${THEME}\ntitle: T\nmember_hash: ${hash}\n---\nA short body.\n`;
  const viaMd = await single(md, "md");
  assert.equal(viaMd.outcome, "failed");
  assert.match(notes(viaMd), /sections must be an object/);
  assert.equal(stored(w).length, 0, "nothing was written by any refused payload");
  assert.match(notes(await single("{")), /not JSON/);
  const ok = await single(JSON.stringify(entry()));
  assert.equal(ok.counts.applied, 1, notes(ok));
  assert.deepEqual([stored(w)[0]?.generated_by, stored(w)[0]?.brief_md], ["theme-briefs-single-payload", renderBriefMd(entry() as never)]);
  assert.equal(stored(w).length, 1, "one row per theme");
});

test("F:15: an invented figure listed under a REAL claim id is not covered by it; F:16: a quarantined member and a suppressed claim are not brief material; F:17: the home jurisdictions name their source", async () => {
  const w = themeWorld();
  const invented = entry({ sections: { ...entry().sections, connection: "The duty carries a fine of EUR 900000 for late filers." }, claims: [{ section: "connection", text: "a fine of EUR 900000", member_id: ITEM, claim_ids: [CLAIM_A] }] });
  assert.match(notes(await apply(w, [invented])), /the listed text states .*"EUR 900000".* that none of its cited grounded claims states/);
  const honest = entry({ sections: { ...entry().sections, connection: "Operators shall report verified annual emissions before 30 April." }, claims: [{ section: "connection", text: "report verified annual emissions before 30 April", member_id: ITEM, claim_ids: [CLAIM_A] }, ...entry().claims.slice(1)] });
  assert.equal((await apply(w, [honest], true)).counts.valid, 1, "a figure the cited claim states is covered");
  // F:16: the member quarantined since the pass, then the claim suppressed
  const themes = await loadThemes(w.db.client, [THEME]);
  assert.equal((await loadThemeMaterial(w.db.client, themes)).claims.some((c) => c.id === CLAIM_A), true);
  w.db.seed("fact_suppressions", [{ id: "f2000000-0000-4000-8000-000000000001", item_id: ITEM, target_kind: "fact", target_ref: CLAIM_A, op: "suppress", machine_value: null, created_at: "2026-10-15T00:00:00Z", revoked_at: null }]);
  const suppressed = await loadThemeMaterial(w.db.client, themes);
  assert.equal(suppressed.claims.some((c) => c.id === CLAIM_A), false, "a suppressed claim never reaches the author");
  assert.match(notes(await apply(w, [honest])), /is not a grounded claim of member/);
  (w.db.rows("intelligence_items").find((r) => r.id === SECOND) as Record<string, unknown>).provenance_status = "quarantined";
  const quarantined = await loadThemeMaterial(w.db.client, themes);
  assert.deepEqual(quarantined.items.map((i) => i.id), [ITEM], "a member that is no longer verified is not material");
  assert.equal(quarantined.claims.some((c) => c.intelligence_item_id === SECOND) || quarantined.events.some((e) => e.intelligence_item_id === SECOND), false);
  // F:17: two workspaces; the union takes the larger weight, a named org reads its own row, a failed read throws
  w.db.seed("workspace_settings", [{ id: "w1", org_id: "00000000-0000-4000-8000-0000000000b2", jurisdiction_weights: { EU: 3, US: 1 } }, { id: "w2", org_id: "00000000-0000-4000-8000-0000000000a1", jurisdiction_weights: { EU: 5, GB: 2 } }]);
  assert.deepEqual((await loadThemeMaterial(w.db.client, themes)).jurisdictionWeights, { EU: 5, GB: 2, US: 1 }, "the default scope is every workspace, never one arbitrary row");
  assert.deepEqual((await loadThemeMaterial(w.db.client, themes, { homes: { orgId: "00000000-0000-4000-8000-0000000000b2" } })).jurisdictionWeights, { EU: 3, US: 1 });
  w.db.failWhen = (c) => (c.table === "workspace_settings" ? "boom" : null);
  await assert.rejects(loadThemeMaterial(w.db.client, themes), /boom|paginated read failed/);
});

test("the flat frontmatter block reads a scalar, an inline array, null and inline JSON, and a text with no block is null", () => {
  assert.deepEqual(parseFrontmatter(`---\na: plain\nb: [x, y]\nc: null\nd: {"k":1}\n---\nbody`)?.fields, { a: "plain", b: ["x", "y"], c: null, d: { k: 1 } });
  assert.equal(parseFrontmatter("no block here"), null);
});

test("the figure rule: a number or an acronym is allowed only inside a listed claim, a labelled analysis paragraph or a heading; ramifications split by surface heading", async () => {
  const w = themeWorld();
  const valid = async (meaning: string) => (await apply(w, [entry({ sections: { ...entry().sections, meaning } })], true)).counts.valid;
  assert.equal(await valid("*Analytical inference:* The report falls due before 30 April each year."), 1, "a labelled analysis paragraph may state a figure the evidence holds");
  assert.equal(await valid("1. First point about the duty."), 1, "an ordered-list marker is not a figure");
  assert.deepEqual([...parseRamifications("### Research\nx\n### Research\ny").problems], ['duplicate ramifications subsection "Research"']);
});

test("the comparator: a figure the cited grounded text does not state as the same quantity is returned; one it states is covered", () => {
  assert.deepEqual(figureCoverage("The duty costs EUR 50 per year.", ["The duty costs EUR 5 per year."]), ["EUR 50"], "EUR 5 never backs EUR 50");
  assert.deepEqual(figureCoverage("The duty costs EUR 900000 per year.", ["The duty costs EUR 500 per year."]), ["EUR 900000"]);
  assert.deepEqual(figureCoverage("The duty costs EUR 500 per year.", ["The duty costs EUR 500 per year."]), []);
});

test("the stand-ins behind the validator: a copy of a validated brief is not a validated brief; admissibleRows keeps verified, unarchived, unsuppressed rows only", async () => {
  assert.equal(isValidThemeBrief({ theme_id: THEME }), false);
  assert.equal(isValidThemeBrief(null), false);
  const w = themeWorld();
  assert.deepEqual([...(await admissibleRows.itemIds(w.db.client, [ITEM, SECOND, "ghost"]))].sort(), [ITEM, SECOND].sort());
  (w.db.rows("intelligence_items").find((r) => r.id === SECOND) as Record<string, unknown>).is_archived = true;
  assert.deepEqual([...(await admissibleRows.itemIds(w.db.client, [ITEM, SECOND]))], [ITEM]);
  const claim = (id: string, item: string) => ({ id, intelligence_item_id: item, claim_text: "t" });
  w.db.seed("fact_suppressions", [{ id: "fs1", item_id: ITEM, target_kind: "fact", target_ref: CLAIM_A, op: "suppress", machine_value: null, created_at: "2026-10-15T00:00:00Z", revoked_at: null }]);
  assert.deepEqual((await admissibleRows.claims(w.db.client, [claim(CLAIM_A, ITEM), claim("c-other", ITEM), claim(CLAIM_B, SECOND)])).map((c) => c.id), ["c-other"], "the suppressed claim and the archived item's claim are out");
});

test("DIGEST-FIX-1: a requested id that is not exported is named in the residue with its reason: no live theme, or a theme whose brief is current", async () => {
  const w = themeWorld();
  const none = await themeBriefsExporter(w.db.client)({ limit: 5, ids: ["no-such-theme"] });
  assert.deepEqual(none.residue, [{ theme_id: "no-such-theme", reason: "no_live_theme" }]);
  await apply(w, [entry()]);
  const done = await themeBriefsExporter(w.db.client)({ limit: 5, ids: [THEME] });
  assert.equal(done.items.length, 0);
  assert.deepEqual(done.residue, [{ theme_id: THEME, reason: "not_needing_brief: its brief is current (generated_by theme-briefs-001)" }]);
});
