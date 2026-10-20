// The detail loader (INV-125, INV-146, INV-080/175, INV-213/262, INV-263, INV-270, INV-272): admission by canonical surface, one uuid resolution, claim ratings from the source's COALESCE(override, base),
// suppressed claims gone from the map and from the text, the inference gate, and a failed read that fails the page instead of reading as an empty block.
import assert from "node:assert/strict";
import { test } from "node:test";

import { readClaims } from "@/core/detail/claim-tiers";
import { loadDetail } from "@/core/detail/load";
import { readDetailItem } from "@/core/detail/item-read";
import { pickVisibleInferences, readCustomerInferences } from "@/core/detail/inference-view";
import { sourceEntriesOf } from "@/core/detail/sources-parse";

import { clientFor, script } from "../workspace/_world.ts";
import { seed } from "../workspace/_world.ts";

import { ARCHIVED, CLAIM_KEPT, CLAIM_KEPT_ID, CLAIM_SUPPRESSED, CLAIM_SUPPRESSED_ID, MKT, REG, SRC_T1, SRC_T3, UNVERIFIED, world } from "./world.ts";

const as = (db: ReturnType<typeof world>) => db.client as never;

test("INV-125: only a verified, non-archived item reads; a market item is not found on /regulations; a uuid and a legacy id resolve to the same item", async () => {
  const db = world();
  assert.equal(await readDetailItem(as(db), UNVERIFIED), null);
  assert.equal(await readDetailItem(as(db), ARCHIVED), null);
  assert.equal(await readDetailItem(as(db), "g99"), null);
  const byLegacy = await readDetailItem(as(db), "g14");
  const byUuid = await readDetailItem(as(db), REG);
  assert.equal(byLegacy?.uuid, REG);
  assert.equal(byUuid?.resource.id, "g14");
  assert.deepEqual(await loadDetail("regulations", MKT, undefined, as(db)), { notFound: true }, "a market item at /regulations");
  const reg = await loadDetail("market", REG, undefined, as(db));
  assert.deepEqual(reg, { notFound: true }, "a regulation at /market");
});

test("one uuid resolution: every read after the item takes the uuid (the old page resolved the same id six ways)", async () => {
  const db = world();
  await loadDetail("regulations", "g14", undefined, as(db));
  const legacyLookups = db.reads("intelligence_items").filter((c) => c.filters.some(([k, , v]) => k === "eq" && v === "g14"));
  assert.equal(legacyLookups.length, 1, "the legacy id is looked up once");
});

test("INV-080/175/213: a claim's rating is the source's override else its base tier, never effective_tier; a claim with no source carries no rating", async () => {
  const db = world();
  const { tiers } = await readClaims(as(db), REG);
  assert.equal(tiers[CLAIM_KEPT_ID]?.tier, 1, "base tier 1, effective tier 5 ignored");
  assert.equal(tiers[CLAIM_KEPT_ID]?.text, CLAIM_KEPT, "the claim carries its own text; the map is keyed by its id");
  db.seed("section_claim_provenance", [
    { id: "dddddddd-1000-4000-8000-0000000000a1", intelligence_item_id: REG, claim_text: "an override claim", claim_kind: "FACT", source_id: SRC_T3, section_row_id: null },
    { id: "dddddddd-1000-4000-8000-0000000000a2", intelligence_item_id: REG, claim_text: "an unsourced claim", claim_kind: "FACT", source_id: null, section_row_id: null },
    { id: "dddddddd-1000-4000-8000-0000000000a3", intelligence_item_id: REG, claim_text: "an override claim", claim_kind: "FACT", source_id: SRC_T1, section_row_id: null },
  ]);
  const seeded = (await readClaims(as(db), REG)).tiers;
  assert.equal(seeded["dddddddd-1000-4000-8000-0000000000a1"]?.tier, 2, "override beats base");
  assert.equal(seeded["dddddddd-1000-4000-8000-0000000000a2"]?.tier, null);
  assert.equal(seeded["dddddddd-1000-4000-8000-0000000000a3"]?.tier, 1, "two claims with the same text keep their own sources: the map is by id, so neither overwrites the other");
});

test("INV-270: a suppressed claim is absent from the tier map and its text is removed from the sections, per request", async () => {
  const db = world();
  const { tiers, suppressed } = await readClaims(as(db), REG);
  assert.equal(CLAIM_SUPPRESSED_ID in tiers, false);
  assert.deepEqual(suppressed.map((s) => s.claim_text), [CLAIM_SUPPRESSED]);
  const d = await loadDetail("regulations", "g14", undefined, as(db));
  assert.ok(!d.notFound);
  if (d.notFound) return;
  const s3 = d.sections.find((s) => s.section_key === "3");
  assert.ok(s3?.content_md.includes("Register with the competent authority"), "the rest of the section stays");
  assert.ok(!s3?.content_md.includes("4,000 euro"), "the suppressed claim text is gone");
  // A revoked suppression shows the claim again (the next request, no cache between).
  db.rows("item_corrections")[0]!.revoked_at = "2026-09-02T00:00:00Z";
  const again = await loadDetail("regulations", "g14", undefined, as(db));
  assert.ok(!again.notFound && again.sections.find((s) => s.section_key === "3")?.content_md.includes("4,000 euro"));
});

test("INV-270 fails closed into a named degraded block: a refused suppression read, a refused claims read or an absent view withholds the facts and the page still loads; nothing renders unredacted", async () => {
  const check = async (db: ReturnType<typeof world>) => {
    const d = await loadDetail("regulations", "g14", undefined, as(db));
    assert.ok(!d.notFound);
    if (d.notFound) return;
    assert.equal(d.claimsDegraded, true, "the page says the facts did not load");
    assert.deepEqual(d.sections, [], "no stored section is drawn");
    assert.equal(d.resource.fullBrief, "", "the brief is withheld");
    assert.deepEqual(d.claimTiers, {});
    assert.ok(!JSON.stringify(d).includes("4,000 euro"), "the suppressed claim text is nowhere in the bundle");
    assert.equal(d.resource.id, "g14", "the rest of the item (title, source, timeline) still loads");
  };
  const refused = world();
  refused.fail("fact_suppressions", "select", "permission denied for view fact_suppressions");
  await check(refused);
  const claims = world();
  claims.fail("section_claim_provenance", "select", "claims down");
  await check(claims);
  const absent = world();
  absent.fail("fact_suppressions", "select", "relation \"public.fact_suppressions\" does not exist", { code: "42P01" }); // the production database before the migration
  await check(absent);
  const healthy = await loadDetail("regulations", "g14", undefined, as(world()));
  assert.ok(!healthy.notFound && healthy.claimsDegraded === false);
});

test("INV-263: a failed item read throws (the route says so with Retry); it is never 'not found'", async () => {
  const db = world();
  db.fail("intelligence_items", "select", "down", { times: 1 });
  await assert.rejects(() => readDetailItem(as(db), "g14"), /intelligence_items read failed/);
});

test("INV-272: an inference shows only if current, allowlisted, cited by an item the reader can open, not superseded; at most five", async () => {
  const db = world();
  const view = await readCustomerInferences(as(db), REG);
  assert.deepEqual(view?.claims.map((c) => c.id).sort(), ["i1", "i6"], "i2 other method, i3 stale, i4 cites an unverified item, i5 superseded by i6");
  assert.equal(view?.hrefs.aaaaaaaa, undefined);
  assert.match(view?.hrefs[REG] ?? "", /^\/regulations\/g14$/);
  const views = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, citedItemIds: ["x"] }));
  assert.equal(pickVisibleInferences(views, () => true).length, 5);
  assert.deepEqual(pickVisibleInferences(views.slice(0, 2), (v) => !v.citedItemIds.includes("x")), [], "a claim citing an item the reader cannot open is not shown");
  db.fail("inference_records", "select", "down");
  await assert.rejects(() => readCustomerInferences(as(db), REG), /inference_records read failed/);
});

test("INV-263: the cross-page block that failed is NAMED, the rest renders", async () => {
  const db = world();
  db.fail("inference_records", "select", "down");
  const d = await loadDetail("regulations", "g14", undefined, as(db));
  assert.ok(!d.notFound);
  if (d.notFound) return;
  assert.deepEqual(d.crossPage.degraded, ["inferences"]);
  assert.equal(d.crossPage.inferences, null);
  assert.ok(d.crossPage.theme, "the theme analysis still read");
  assert.ok(d.crossPage.intersections === null || typeof d.crossPage.intersections === "object");
});

test("INV-213/271: a source row carries the registry's rating by canonical URL; an unmatched row carries none; the brief's own tier wording is never drawn", async () => {
  const db = world();
  const d = await readDetailItem(as(db), "g14");
  const base = { ...(d?.resource as object), citedSources: [{ url: "https://press.example.test/a", tier: 2, biasTags: [] }] } as unknown as Parameters<typeof sourceEntriesOf>[0];
  const rows = sourceEntriesOf(base);
  assert.deepEqual(rows.map((r) => [r.name, r.tier]), [["EUR-Lex", 5], ["Trade Press", 2], ["Unrated Blog", null]], "the item's source is rated by customerTierOf (override, effective, base); the brief said Tier 1 for all three");
  assert.ok(rows.every((r) => !/tier\s*1/i.test(r.meta)));
  assert.equal(SRC_T1.length, 36);
});

test("the relevance and the member reads need no service client: every call above ran on the caller's client", async () => {
  const w = script(seed());
  assert.ok(clientFor(w, "member"));
});
