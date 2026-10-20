// R2d S3, flywheel:27 (INV-270 fails closed): redaction covers every text column and an unmatched suppressed text hides the claim; a failed cache flush is told to the admin. The register's wrong outcomes are
// the cases: a suppressed claim stayed in the summary, the key data and the stated intersection summary; a claim the section no longer held verbatim left the section on the page; a failed flush was swallowed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadDetail } from "@/core/detail/load";
import { POST, REVOKE } from "@/features/corrections/api";
import { redactDeep, redactSuppressedClaims } from "@/features/corrections/redact";

import { fakeDb } from "../_support/fake-db.ts";
import { as, ctx, json, script } from "../_support/personas.ts";
import { CLAIM_KEPT, CLAIM_SUPPRESSED, REG, world } from "../detail/world.ts";

const dbOf = (db: ReturnType<typeof world>) => db.client as never;
const SECTION = "cccccccc-1000-4000-8000-000000000003";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CORR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const claim = { id: "dddddddd-1000-4000-8000-000000000002", claim_text: CLAIM_SUPPRESSED, section_row_id: SECTION, item_id: REG };

test("redactDeep removes the claim from every string it was copied to, drops an entry that was only the claim, and leaves everything else as it was", () => {
  const out = redactDeep({ note: `${CLAIM_KEPT}  ${CLAIM_SUPPRESSED}`, keyData: [CLAIM_SUPPRESSED, "a figure that stays", `- ${CLAIM_SUPPRESSED}`], nested: { text: `before ${CLAIM_SUPPRESSED} after`, n: 4, nothing: null }, empty: "" }, [claim]);
  assert.equal(out.note.trim(), CLAIM_KEPT);
  assert.deepEqual(out.keyData, ["a figure that stays"]);
  assert.equal(out.nested.text.replace(/\s+/g, " ").trim(), "before after");
  assert.deepEqual([out.nested.n, out.nested.nothing, out.empty], [4, null, ""]);
  const same = { note: "untouched" };
  assert.equal(redactDeep(same, []), same, "no suppression, no copy");
});

test("an unmatched suppressed claim hides its section: the claim's text is not in the section it belongs to, so the section is emptied (and the brief, when it does not hold the claim either); a matched one is removed and the rest stands", () => {
  const reworded = { id: SECTION, content_md: "The penalty is four thousand euro a tonne, in every case." };
  const lost = redactSuppressedClaims({ sections: [reworded], fullBrief: "Body without the claim.", claims: [claim] });
  assert.equal(lost.sections[0]?.content_md, "", "the old pass left the section, and the claim in it, on the page");
  assert.equal(lost.fullBrief, "");
  assert.equal(lost.report[0]?.section_found, false);
  const inBrief = redactSuppressedClaims({ sections: [reworded], fullBrief: `Body. ${CLAIM_SUPPRESSED}`, claims: [claim] });
  assert.equal(inBrief.sections[0]?.content_md, "", "the section is withheld");
  assert.ok(!inBrief.fullBrief?.includes(CLAIM_SUPPRESSED), "the brief held it verbatim: it is removed, not withheld");
  assert.match(inBrief.fullBrief ?? "", /Body\./);
  const matched = redactSuppressedClaims({ sections: [{ id: SECTION, content_md: `${CLAIM_KEPT}\n\n${CLAIM_SUPPRESSED}` }], fullBrief: null, claims: [claim] });
  assert.equal(matched.sections[0]?.content_md.trim(), CLAIM_KEPT);
});

test("the detail page carries the suppression into the summary, the key data and the stated intersection summary, and withholds a section whose suppressed claim it can no longer find", async () => {
  const db = world();
  const reg = db.rows("intelligence_items").find((i) => i.id === REG)!;
  Object.assign(reg, { summary: `Summary. ${CLAIM_SUPPRESSED}`, key_data: [CLAIM_SUPPRESSED, "kept key figure"], intersection_summary: `Linked. ${CLAIM_SUPPRESSED}` });
  const d = await loadDetail("regulations", "g14", undefined, dbOf(db));
  assert.ok(!d.notFound);
  if (d.notFound) return;
  assert.ok(!JSON.stringify(d).includes("4,000 euro"), "the suppressed text is in no column of the bundle");
  assert.deepEqual(d.resource.keyData, ["kept key figure"]);
  assert.match(d.resource.note, /^Summary\./);
  const lost = world();
  const s3 = lost.rows("intelligence_item_sections").find((s) => s.id === SECTION)!;
  s3.content_md = `${CLAIM_KEPT} A penalty of four thousand euro per tonne applies.`;
  const withheld = await loadDetail("regulations", "g14", undefined, dbOf(lost));
  assert.ok(!withheld.notFound);
  if (withheld.notFound) return;
  assert.equal(withheld.sections.find((s) => s.id === SECTION)?.content_md, "", "the section whose suppressed claim is not found in it is withheld");
  const stored = new Map(lost.rows("intelligence_item_sections").map((s) => [String(s.id), s.content_md]));
  assert.ok(withheld.sections.filter((s) => s.id !== SECTION).every((s) => s.content_md === stored.get(String(s.id))), "the other sections stand as stored");
});

test("a correction is answered as recorded, with no cache verdict: nothing in the app keeps a detail page, so the next read shows it", async () => {
  script(fakeDb((c) => (c.table === "intelligence_items" ? { data: { id: ITEM } } : c.table === "item_corrections" || c.table === "section_claim_provenance" ? { data: [] } : undefined), { rpc: (name) => (name === "create_item_correction" ? { data: CORR } : name === "revoke_item_correction" ? { data: null } : { data: null }) }));
  const create = async () => POST(as("platformAdmin", "/x", { method: "POST", body: json({ target_kind: "fact", target_ref: "b".repeat(8) + "-bbbb-4bbb-8bbb-bbbbbbbbbbbb", op: "suppress", reason: "wrong figure" }) }), ctx({ id: ITEM }) as never);
  const ok = await create();
  const body = (await ok.json()) as Record<string, unknown>;
  assert.equal(ok.status, 201);
  assert.equal("cache" in body, false);
  const revoked = await REVOKE(as("platformAdmin", "/x", { method: "POST", body: json({ reason: "mistake" }) }), ctx({ id: ITEM, correctionId: CORR }) as never);
  assert.equal(revoked.status, 200);
  assert.equal("cache" in ((await revoked.json()) as Record<string, unknown>), false);
});
