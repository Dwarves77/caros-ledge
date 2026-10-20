// The extractor reads the item's own primary text (IMPACT-1, measured on production 2026-10-20: the brief-only extractor found a dated duty in 9 of 1,129 items the capture-reading one finds in 466): a date located in a capture is a medium-confidence event that
// names its capture and is verbatim in it; a date the brief already carries is that one (claim-backed preferred); a duty window is the sentence whose subject is a duty holder, opened at the Article heading before it, never a cross-reference.
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveObligationObjects, extractForwardEvents } from "@/features/obligations";
import { sameObligationContent } from "@/features/obligations/extract/dedupe";
import { insertForwardEvents } from "@/features/obligations/extract/write-forward-events";
import { isVerbatim } from "@/core/contracts/verbatim";

import { C1, capture, DUTY_TEXT, I1, item, NO_DUTY_TEXT, world } from "./_world.ts";

const SENTENCE = "This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety.";

test("a date in a capture is an event of kind capture: medium confidence, the capture named, the date span verbatim in the capture", () => {
  const out = extractForwardEvents({ claims: [], sections: [], captures: [{ capture_id: "c1", text: `Article 4. ${SENTENCE}` }], referenceDates: ["2026-10-15"] });
  assert.equal(out.events.length, 1);
  const e = out.events[0]!;
  assert.deepEqual([e.source_kind, e.confidence, e.source_capture_id, e.source_claim_id, e.source_section_id, e.event_kind, e.event_date], ["capture", "medium", "c1", null, null, "entry_into_force", "2027-01-01"]);
  assert.ok(isVerbatim(`Article 4. ${SENTENCE}`, e.source_span));
});

test("the same sentence from a claim and from a capture is one event, the claim-backed one (a window opened mid-sentence carries an ellipsis and the capture's ends in a full stop; neither makes it another event)", () => {
  const out = extractForwardEvents({ claims: [{ claim_id: "k1", kind: "FACT", text: "x", span: SENTENCE }], sections: [], captures: [{ capture_id: "c1", text: SENTENCE }], referenceDates: [] });
  assert.deepEqual(out.events.map((e) => [e.source_kind, e.confidence]), [["claim", "high"]]);
  assert.equal(out.counts.dedupe_dropped, 1);
});

test("the same sentence is the same event whether its window opened mid-sentence (an ellipsis) or ended at a full stop", () => {
  assert.equal(sameObligationContent("…shall enter into force on 1 January 2027 and shall be binding in its entirety…", SENTENCE), true);
  assert.equal(sameObligationContent("…shall enter into force on 1 January 2027 and shall be binding in its entirety…", "It shall apply from 1 January 2028 to every operator established in the Union."), false);
});

test("a capture-backed row is judged stale only by a caller that lists the captures it holds", async () => {
  const db = world([item(I1)], [capture(C1, I1, DUTY_TEXT)]);
  db.seed("item_forward_events", [{ intelligence_item_id: I1, event_date: "2027-01-01", date_precision: "day", event_kind: "entry_into_force", obligation_text: "x", source_kind: "capture", source_capture_id: "gone", source_span: "1 January 2027", confidence: "medium", extractor_version: "t" }]);
  const stale = async (captureIds?: ReadonlySet<string>) => (await insertForwardEvents(db.client, I1, [], { claimIds: new Set(), sectionIds: new Set(), ...(captureIds ? { captureIds } : {}) }, { dry: true })).staleIds.length;
  assert.deepEqual([await stale(), await stale(new Set([C1])), await stale(new Set(["gone"]))], [0, 1, 0]);
});

test("duty windows: the sentence whose subject is a duty holder, opened at its Article heading; a holder named after the verb and an Article that cites another instrument name no duty", async () => {
  const plan = async (text: string) => {
    const db = world([item(I1, { instrument_identifier: "Regulation (EU) 2026/77" })], [capture(C1, I1, text)]);
    return (await deriveObligationObjects(db.client, { dry: true, itemIds: [I1] })).data?.plan;
  };
  const duty = await plan(DUTY_TEXT);
  assert.deepEqual(duty?.toInsert.map((p) => p.row.pinpoint_citation).sort(), ["Article 5", "Article 6"]);
  assert.ok(duty?.toInsert.every((p) => String(p.row.verbatim_text).startsWith("Article ")), "a window opens at its heading");
  const none = await plan(NO_DUTY_TEXT);
  assert.deepEqual([none?.toInsert.length, none?.refused.length], [0, 0], "'binding in all Member States' is not a duty of Member States, and Article 3(1) of another Directive is not this instrument's pinpoint");
  const afterTheVerb = await plan(`${"Applicability of the instrument. ".repeat(10)}
Article 4 Entry into force
This Regulation shall be binding in its entirety and directly applicable in all Member States.`);
  assert.equal(afterTheVerb?.toInsert.length, 0, "a holder named after the verb is where the Regulation applies, not who bears the duty");
  const crossRef = await plan(`${"Operators of vessels. ".repeat(12)}\nArticle 3(1) of Directive (EU) 2019/883 applies. Carriers shall keep the records of each voyage for the period the Directive sets.`);
  assert.equal(crossRef?.toInsert.length, 0, "an Article that cites another instrument is a cross-reference, not a heading");
});
