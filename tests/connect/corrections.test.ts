// Corrections: the persona matrix for the admin routes, the validation and error map, and one full round trip: suppress a fact, it is not rendered,
// regeneration (new claim ids, same text) does not restore it, revoke restores it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCorrection, GET, listCorrections, mapDbError, planCorrection, POST, REVOKE, revokeCorrection } from "@/features/corrections/api";
import { findOrphanedFactCorrections, suppressedClaimMatcher, isPairTombstoned, latestPerTarget, removedTagsFor, tombstonedPairKeys, validateCorrectionInput, type Correction } from "@/core/corrections";
import { loadSuppressedClaims, redactSuppressedClaims, removeClaimText } from "@/features/corrections/redact";

import { fakeDb } from "../_support/fake-db.ts";
import { as, ctx, json, PERSONAS, script, type Persona } from "../_support/personas.ts";

import { connectDb } from "./world.ts";

const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CORR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type Row = Record<string, unknown>;

const status = async (h: (r: Request, c: never) => Promise<Response>, p: Persona, url: string, init: RequestInit, params: Record<string, string>) => (await h(as(p, url, init), ctx(params) as never)).status;
const expected = (admin: number): Record<Persona, number> => ({ anon: 401, viewer: 403, otherOrgMember: 403, member: 403, owner: 403, platformAdmin: admin });

test("persona matrix: the three corrections routes answer only a platform admin", async () => {
  script(fakeDb((c) => (c.table === "intelligence_items" ? { data: { id: ITEM } } : c.table === "item_corrections" || c.table === "section_claim_provenance" ? { data: [] } : undefined), { rpc: (name) => (name === "create_item_correction" ? { data: CORR } : { data: null }) }));
  const body = json({ target_kind: "fact", target_ref: CLAIM, op: "suppress", reason: "wrong figure" });
  for (const p of PERSONAS) {
    assert.equal(await status(GET, p, `/api/admin/items/${ITEM}/corrections`, {}, { id: ITEM }), expected(200)[p], `GET as ${p}`);
    assert.equal(await status(POST, p, `/api/admin/items/${ITEM}/corrections`, { method: "POST", body }, { id: ITEM }), expected(201)[p], `POST as ${p}`);
    assert.equal(await status(REVOKE, p, `/x`, { method: "POST", body: json({ reason: "mistake" }) }, { id: ITEM, correctionId: CORR }), expected(200)[p], `REVOKE as ${p}`);
  }
});

test("the actor is the session user, never the body", async () => {
  const svc = fakeDb((c) => (c.table === "intelligence_items" ? { data: { id: ITEM } } : undefined), { rpc: () => ({ data: CORR }) });
  script(svc);
  await POST(as("platformAdmin", "/x", { method: "POST", body: json({ target_kind: "fact", target_ref: CLAIM, op: "suppress", reason: "r", created_by: "someone-else" }) }), ctx({ id: ITEM }) as never);
  const args = svc.rpcs.find((r) => r.name === "create_item_correction")?.args as Row;
  assert.equal(args.p_created_by, "u-admin");
});

test("a failed read is an error status, never an empty list", async () => {
  const bad = connectDb({ intelligence_items: [{ id: ITEM }] }, { failures: [{ table: "item_corrections", op: "select", message: "down" }] });
  assert.equal((await listCorrections(bad.db, ITEM)).status, 500);
  const none = connectDb({});
  assert.equal((await listCorrections(none.db, ITEM)).status, 404);
  const itemDown = connectDb({}, { failures: [{ table: "intelligence_items", op: "select", message: "down" }] });
  assert.equal((await listCorrections(itemDown.db, ITEM)).status, 500);
  assert.equal((await listCorrections(none.db, "not-a-uuid")).status, 400);
});

test("validation: reason, kind, op, ref shapes", () => {
  const v = (b: unknown) => validateCorrectionInput(b);
  assert.equal((v({ target_kind: "fact", target_ref: CLAIM, op: "suppress" }) as { code: string }).code, "reason_required");
  assert.equal((v({ target_kind: "nope", target_ref: "x", op: "x", reason: "r" }) as { code: string }).code, "target_kind_invalid");
  assert.equal((v({ target_kind: "fact", target_ref: CLAIM, op: "add", reason: "r" }) as { code: string }).code, "op_invalid");
  assert.equal((v({ target_kind: "fact", target_ref: "x", op: "suppress", reason: "r" }) as { code: string }).code, "target_ref_invalid");
  assert.equal((v({ target_kind: "fact", target_ref: CLAIM, op: "replace", reason: "r", value: { source_span: "s" } }) as { code: string }).code, "fact_needs_span");
  assert.equal((v({ target_kind: "tag", target_ref: "nope:x", op: "remove", reason: "r" }) as { code: string }).code, "target_ref_invalid");
  assert.equal((v({ target_kind: "tag", target_ref: "topic_tags:emissions", op: "remove", reason: "r" }) as { ok: boolean }).ok, true);
  assert.equal(planCorrection("nope", "u", {}).ok, false);
});

test("database errors map to statuses", () => {
  assert.equal(mapDbError({ message: "correction_item_not_found: no item" }).status, 404);
  assert.equal(mapDbError({ message: "correction_not_active: gone" }).status, 409);
  assert.equal(mapDbError({ message: "correction_reason_required: x" }).status, 400);
  assert.equal(mapDbError({ message: "correction_other: x" }).status, 422);
  assert.equal(mapDbError({ message: "boom" }).status, 500);
});

const world = () => {
  let seq = 0;
  // eslint-disable-next-line prefer-const
  let m: ReturnType<typeof connectDb>;
  const rpc = (name: string, a: unknown) => {
    const args = a as Row;
    const t = m.tables;
    if (name === "create_item_correction") {
      const claim = (t.section_claim_provenance ?? []).find((c) => c.id === args.p_target_ref);
      const id = `corr-${++seq}`;
      (t.item_corrections ??= []).push({ id, item_id: args.p_item_id, target_kind: args.p_target_kind, target_ref: args.p_target_ref, op: args.p_op, value: args.p_value, machine_value: claim ? { claim_text: claim.claim_text } : null, reason: args.p_reason, created_at: `2026-10-0${seq}T00:00:00Z`, revoked_at: null });
      return { data: id };
    }
    if (name === "revoke_item_correction") {
      const row = (t.item_corrections ?? []).find((c) => c.id === args.p_correction_id);
      if (!row || row.revoked_at) return { error: { message: "correction_not_active: already revoked" } };
      row.revoked_at = "2026-10-09T00:00:00Z";
      return { data: null };
    }
    return { data: null };
  };
  m = connectDb({
    intelligence_items: [{ id: ITEM, full_brief: "Intro. The levy is 42 EUR per tonne. Outro." }],
    intelligence_item_sections: [{ id: "s1", item_id: ITEM, content_md: "- The levy is 42 EUR per tonne.\n- Other fact." }],
    section_claim_provenance: [{ id: CLAIM, intelligence_item_id: ITEM, claim_text: "The levy is 42 EUR per tonne.", section_row_id: "s1" }],
  }, { rpc });
  m.mem.views.fact_suppressions = () => (m.tables.item_corrections ?? []).filter((c) => c.target_kind === "fact");
  return m;
};
const render = async (m: ReturnType<typeof world>) => {
  const claims = await loadSuppressedClaims(m.db, [ITEM]);
  return { claims, ...redactSuppressedClaims({ sections: m.tables.intelligence_item_sections as { id: string; content_md: string }[], fullBrief: "Intro. The levy is 42 EUR per tonne. Outro.", claims }) };
};

test("round trip: suppress, not rendered, regeneration does not restore, revoke restores", async () => {
  const m = world();
  const before = await render(m);
  assert.match(before.sections[0]?.content_md ?? "", /levy/);

  const made = await createCorrection(m.db, { itemId: ITEM, userId: "u-admin", body: { target_kind: "fact", target_ref: CLAIM, op: "suppress", reason: "wrong figure" } });
  assert.equal(made.status, 201);
  const after = await render(m);
  assert.equal(after.claims.length, 1);
  assert.doesNotMatch(after.sections[0]?.content_md ?? "", /levy/);
  assert.match(after.sections[0]?.content_md ?? "", /Other fact/);
  assert.doesNotMatch(after.fullBrief ?? "", /levy/);

  // Regeneration: the claim row is rewritten with a NEW id and the same text; the suppression follows the text.
  (m.tables.section_claim_provenance as Row[])[0] = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", intelligence_item_id: ITEM, claim_text: "The levy is 42 EUR per tonne.", section_row_id: "s1" };
  const regenerated = await render(m);
  assert.equal(regenerated.claims.length, 1, "the correction still applies to the regenerated claim");
  assert.doesNotMatch(regenerated.sections[0]?.content_md ?? "", /levy/);

  const id = (m.tables.item_corrections as Row[])[0]?.id as string;
  assert.equal((await revokeCorrection(m.db, { itemId: ITEM, correctionId: CORR, userId: "u", body: {} })).status, 409, "an unknown correction is not active");
  assert.equal((await revokeCorrection(m.db, { itemId: ITEM, correctionId: "nope", userId: "u", body: {} })).status, 400);
  m.tables.item_corrections![0]!.id = CORR;
  assert.equal((await revokeCorrection(m.db, { itemId: ITEM, correctionId: CORR, userId: "u", body: { reason: "mistake" } })).status, 200);
  void id;
  const revoked = await render(m);
  assert.equal(revoked.claims.length, 0);
  assert.match(revoked.sections[0]?.content_md ?? "", /levy/, "revoking restores the fact");
  assert.equal((await revokeCorrection(m.db, { itemId: ITEM, correctionId: CORR, userId: "u", body: {} })).status, 409, "a second revoke is refused");
});

test("loadSuppressedClaims: a failed correction read throws; nothing renders unredacted on a failure", async () => {
  const bad = connectDb({}, { failures: [{ table: "fact_suppressions", op: "select", message: "down" }] });
  await assert.rejects(() => loadSuppressedClaims(bad.db, [ITEM]), /fact_suppressions read failed: down/);
  const claimFail = connectDb({ fact_suppressions: [{ id: "c", item_id: ITEM, target_kind: "fact", target_ref: CLAIM, op: "suppress", created_at: "2026-01-01T00:00:00Z", revoked_at: null }] }, { failures: [{ table: "section_claim_provenance", op: "select", message: "down" }] });
  await assert.rejects(() => loadSuppressedClaims(claimFail.db, [ITEM]), /section_claim_provenance read failed/);
});

test("the newest active correction decides: a later add clears a remove; a revoked row decides nothing; orphans are reported", () => {
  const c = (over: Partial<Correction>): Correction => ({ item_id: "i", target_kind: "tag", target_ref: "topic_tags:x", op: "remove", created_at: "2026-01-01T00:00:00Z", revoked_at: null, id: "1", ...over });
  assert.deepEqual([...removedTagsFor([c({})], "i").topic_tags], ["x"]);
  assert.equal(removedTagsFor([c({}), c({ id: "2", op: "add", created_at: "2026-02-01T00:00:00Z" })], "i").topic_tags.size, 0);
  assert.equal(removedTagsFor([c({ revoked_at: "2026-03-01T00:00:00Z" })], "i").topic_tags.size, 0);
  assert.equal(latestPerTarget([c({}), c({ id: "2", op: "add", created_at: "2026-02-01T00:00:00Z" })]).size, 1);
  const conn = c({ target_kind: "connection", target_ref: "j", op: "remove" });
  assert.equal(isPairTombstoned(tombstonedPairKeys([conn]), "j", "i"), true, "a pair is unordered");
  assert.equal(findOrphanedFactCorrections([c({ target_kind: "fact", target_ref: CLAIM, op: "suppress" })], []).length, 1);
});

test("removeClaimText tolerates whitespace and escaped brackets and reports a miss", () => {
  assert.deepEqual(removeClaimText("a\n- b  c\nd", "b c"), { text: "a\n\nd", found: true });
  assert.equal(removeClaimText("x", "y").found, false);
  assert.equal(removeClaimText("\\[A\\] z", "[A] z").found, true);
});

test("a suppression matches a claim by id first, then by the machine text", () => {
  const row: Correction = { item_id: ITEM, target_kind: "fact", target_ref: CLAIM, op: "suppress", machine_value: null, created_at: "2026-01-01T00:00:00Z", revoked_at: null, id: "1" };
  const match = suppressedClaimMatcher([row], ITEM);
  assert.equal(match({ id: CLAIM, claim_text: "anything" }), true);
  assert.equal(match({ id: "other", claim_text: "anything" }), false);
  const byText = suppressedClaimMatcher([{ ...row, machine_value: { claim_text: "T" } }], ITEM);
  assert.equal(byText({ id: "new-id", claim_text: "T" }), true);
});
