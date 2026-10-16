import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFrontmatter, parseFrontmatter } from "@/core/briefs/frontmatter";
import { findUncitedFigures, parseRamifications, renderBriefMd } from "@/core/briefs/theme-brief-contract";
import { computeMemberHash } from "@/core/flywheel/themes";
import { applyBatch } from "@/features/batches";
import { themeBriefsExporter } from "@/features/batches/kinds/theme-briefs/apply";

import { batchFile, ITEM } from "./world.ts";
import { CLAIM_A, CLAIM_B, EVENT_B, SECOND, THEME, themeWorld, type World } from "./worlds.ts";

const hash = computeMemberHash([SECOND, ITEM]);
const entry = (over: Record<string, unknown> = {}) => ({
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
  const tiny = (await themeBriefsExporter(w.db.client, { charBudget: 700 })({ limit: 5 })).items as unknown as { truncation: { members_omitted: number; chars_used: number } }[];
  assert.ok(tiny[0] && tiny[0].truncation.chars_used <= 700 * 2, "an over-small budget cuts and counts, it does not silently drop");
});

test("a single brief goes through the same seam: as JSON, or as markdown with a frontmatter block; a stale hash is refused", async () => {
  const w = themeWorld();
  const payload = { theme_id: THEME, title: "T", brief_md: "body", member_hash: hash };
  assert.equal((await applyBatch("theme-briefs", w.deps, { content: JSON.stringify({ ...payload, member_hash: "x" }), dry: false })).outcome, "failed");
  const md = `${buildFrontmatter({ theme_id: THEME, title: "T", member_hash: hash })}\nA short body.\n`;
  const r = await applyBatch("theme-briefs", w.deps, { content: md, format: "md", dry: false });
  assert.equal(r.counts.written, 1, notes(r));
  assert.deepEqual([stored(w)[0]?.generated_by, stored(w)[0]?.brief_md], ["session-executor", "A short body."]);
  assert.equal((await applyBatch("theme-briefs", w.deps, { content: JSON.stringify(payload), dry: false })).counts.written, 1);
  assert.equal(stored(w).length, 1, "one row per theme: the seam upserts");
  assert.match(notes(await applyBatch("theme-briefs", w.deps, { content: "{", dry: false })), /not JSON/);
});

test("the flat frontmatter block round-trips what it can carry and refuses what it cannot (a newline, a comma in an inline-array item, a quoted scalar)", () => {
  const text = buildFrontmatter({ a: "plain", b: ["x", "y"], c: null, d: { json: { k: 1 } } });
  assert.deepEqual(parseFrontmatter(`${text}body`)?.fields, { a: "plain", b: ["x", "y"], c: null, d: { k: 1 } });
  assert.throws(() => buildFrontmatter({ a: "two\nlines" }), /newline/);
  assert.throws(() => buildFrontmatter({ a: ["EUR 500,000"] }), /comma/);
  assert.throws(() => buildFrontmatter({ a: '"quoted"' }), /matching quote/);
  assert.equal(parseFrontmatter("no block here"), null);
});

test("the figure rule: a number or an acronym is allowed only inside a listed claim, a labelled analysis paragraph or a heading; ramifications split by surface heading", () => {
  assert.deepEqual(findUncitedFigures("CBAM costs 5%"), ["5%", "CBAM"]);
  assert.deepEqual(findUncitedFigures("CBAM costs 5%", { claimTexts: ["CBAM costs 5%"] }), []);
  assert.deepEqual(findUncitedFigures("*Analytical inference:* CBAM costs 5%"), []);
  assert.deepEqual(findUncitedFigures("1. First point"), [], "an ordered-list marker is not a figure");
  assert.deepEqual([...parseRamifications("### Research\nx\n### Research\ny").problems], ['duplicate ramifications subsection "Research"']);
});
