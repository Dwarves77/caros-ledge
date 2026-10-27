// VISIBLE-FIX-2: the one judgement of "this page shows this item" (scripts/lib/item-on-page.mjs), shared by scripts/runs/visible.mjs and the live check appliedItemsRender
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { itemOnPageFinding } from "../../scripts/lib/item-on-page.mjs";
// @ts-expect-error plain .mjs module
import { finding } from "../../scripts/runs/visible.mjs";

const UUID = "b293a2b6-c882-44dc-8efc-a801ed6a160b";
const page = (o: Record<string, unknown>) => ({ status: 200, finalUrl: "https://x.test/regulations/g19", markers: 3, itemId: UUID, ...o });

test("a uuid that landed on its legacy slug passes when data-item-id is the uuid; the URL is never judged", () => {
  assert.equal(itemOnPageFinding(UUID, "/regulations/x", page({})), null);
});

test("the slug in data-item-id (the VISIBLE-FIX-1 defect) fails, and so do a missing attribute, no marker, an error and an HTTP error", () => {
  assert.match(itemOnPageFinding(UUID, "/p", page({ itemId: "g19" })), /shows item g19, not the item/);
  assert.match(itemOnPageFinding(UUID, "/p", page({ itemId: null })), /no data-item-id/);
  assert.match(itemOnPageFinding(UUID, "/p", page({ markers: 0 })), /drew no/);
  assert.match(itemOnPageFinding(UUID, "/p", { error: "boom" }), /did not load/);
  assert.match(itemOnPageFinding(UUID, "/p", page({ status: 404 })), /HTTP 404/);
});

test("visible.mjs uses the same judgement, not a copy", () => {
  assert.equal(finding, itemOnPageFinding);
});
