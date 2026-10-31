// POOL-FIX-1 (ruling 57; OPS-FIX-1 measured 132 + 66 events of the maritime ETS item sourced from the PPWR and HDV CO2 regulations): the provenance heal filed other instruments' captures under the items that cited them
// (search_query heal-provenance:capture-cited). Every reader that turns an item's pool into mandates reads the item's OWN instrument only; a capture-cited copy of the item's own instrument stays.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isForeignCapture } from "@/core/fetch";
import { deriveObligationObjects, readExtractionInput, resolvePendingTriggers } from "@/features/obligations";

import { C1, C2, C3, DUTY_TEXT, I1, NOW, capture, item, world } from "../impact/_world.ts";

const CITED = "heal-provenance:capture-cited";
const OWN_URL = "https://publications.europa.eu/resource/celex/32023L0958";
const FOREIGN_URL = "https://publications.europa.eu/resource/celex/32025R0040";
const ETS = { canonical_instrument_key: "32023L0958", instrument_identifier: "2023/958", source_url: "https://eur-lex.europa.eu/legal-content/EN/TXT?uri=CELEX:32023L0958" };
const cited = (id: string, url: string, text = DUTY_TEXT) => ({ ...capture(id, I1, text), result_url: url, search_query: CITED });

test("isForeignCapture: a capture-cited copy of another instrument is foreign; of the item's own instrument, a page naming no instrument, or any other kind of capture it is not", () => {
  const it = { id: I1, ...ETS };
  assert.deepEqual(
    [
      isForeignCapture({ search_query: CITED, result_url: FOREIGN_URL }, it),
      isForeignCapture({ search_query: CITED, result_url: OWN_URL }, it),
      isForeignCapture({ search_query: CITED, result_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02023L0958-20240301" }, it),
      isForeignCapture({ search_query: CITED, result_url: "https://finance.ec.europa.eu/" }, it),
      isForeignCapture({ search_query: "canonical:generate-pool", result_url: FOREIGN_URL }, it),
    ],
    [true, false, false, false, false],
  );
});

test("the extraction input holds the item's own capture-cited copy and not another instrument's", async () => {
  const db = world([item(I1, ETS)], [cited(C1, OWN_URL), cited(C2, FOREIGN_URL), { ...capture(C3, I1, DUTY_TEXT), result_url: FOREIGN_URL, search_query: "canonical:generate-pool" }]);
  const input = await readExtractionInput(db.client, I1, NOW);
  assert.deepEqual(input.captures.map((c) => c.capture_id).sort(), [C1, C3]);
});

test("obligation objects are derived from the item's own capture, never from another instrument's", async () => {
  const plan = async (rows: ReturnType<typeof cited>[]) => (await deriveObligationObjects(world([item(I1, ETS)], rows).client, { dry: true, itemIds: [I1] })).data?.plan.toInsert.length;
  assert.deepEqual([await plan([cited(C1, OWN_URL)]), await plan([cited(C2, FOREIGN_URL)])], [2, 0]);
});

test("a pending trigger is not resolved by another instrument's later capture", async () => {
  const text = `${"Notice. This text is provided for information only and is not the authentic version. ".repeat(4)} Commission Implementing Regulation (EU) 2025/1234 was adopted.`;
  const pending = { id: "e1", intelligence_item_id: I1, event_kind: "implementing_act_due", created_at: "2026-01-01T00:00:00.000Z", source_capture_id: null, resolved_at: null };
  const resolved = async (url: string) => {
    const db = world([item(I1, ETS)], [{ ...cited(C1, url, text), searched_at: "2026-06-01T00:00:00.000Z" }], { item_forward_events: [pending] });
    return (await resolvePendingTriggers({ sb: db.client, now: () => NOW }, { dry: true, itemIds: [I1] })).counts?.resolved;
  };
  assert.deepEqual([await resolved(OWN_URL), await resolved(FOREIGN_URL)], [1, 0]);
});
