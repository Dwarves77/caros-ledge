// The three routes this slice owns, with the persona matrix: /api/detail/relevance (signed-in callers only, BUILD-PLAN ruling 3), /api/listings/rest (the rest of a list) and /api/saved-views (personal per user,
// IMP-064). A failed read is a 503 with Retry-After, never an empty 200.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GET as relevance } from "@/features/regulations/api/relevance";
import { GET as rest } from "@/features/lists/api/rest";
import { DELETE as removeView, GET as listViews, POST as saveView } from "@/features/saved-views/api/saved-views";

import { scripted } from "../_support/fake-clients.ts";
import { call, E, ITEM_1, ORG_A, script, seed, USER } from "../workspace/_world.ts";

const VIEWS = "/api/saved-views";
/** The documented cap: fifty saved views per list. */
const MAX_VIEWS_PER_SURFACE = 50;

test("persona matrix: /api/detail/relevance answers every signed-in caller and refuses an anonymous one (the old route answered anyone on an IP limit)", async () => {
  const run = async (persona: Parameters<typeof call>[1]) => {
    script(seed());
    return (await call(relevance, persona, "GET", "/api/detail/relevance?itemId=o3")).status;
  };
  const got = { anon: await run("anon"), viewer: await run("viewer"), member: await run("member"), admin: await run("admin"), owner: await run("owner"), otherOrgMember: await run("otherOrgMember"), platformAdmin: await run("platformAdmin") };
  assert.deepEqual(got, E(401, 200, 200, 200, 200, 200, 200));
});

test("relevance: a member gets the lens and the binding; a caller with no workspace gets the binding without a lens; an unknown item gets nulls; a failed read is a 503, not an empty 200", async () => {
  const db = script(seed());
  const member = await call(relevance, "member", "GET", "/api/detail/relevance?itemId=o3");
  assert.ok(member.body.relevance && typeof member.body.relevance === "object");
  assert.deepEqual((member.body.binding as { decomposed: boolean }).decomposed, false, "no obligation objects: not decomposed, said as such");
  const nobody = await call(relevance, "platformAdmin", "GET", "/api/detail/relevance?itemId=o3");
  assert.equal(nobody.body.relevance, null);
  assert.ok(nobody.body.binding);
  assert.deepEqual((await call(relevance, "member", "GET", "/api/detail/relevance?itemId=nope")).body, { relevance: null, binding: null });
  assert.deepEqual((await call(relevance, "member", "GET", "/api/detail/relevance")).body, { relevance: null, binding: null });
  db.fail("obligation_objects", "select", "down");
  const failed = await call(relevance, "member", "GET", "/api/detail/relevance?itemId=o3");
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("Retry-After"), "1");
  const archived = await call(relevance, "member", "GET", "/api/detail/relevance?itemId=o9");
  assert.deepEqual(archived.body, { relevance: null, binding: null }, "an archived item has no lens");
});

test("/api/listings/rest: signed-in callers only, a named list only, the rows trimmed, a failed read is a 503", async () => {
  const db = script(seed());
  const row = (id: string, legacy: string | null) => ({ id, legacy_id: legacy, title: `T ${id}`, domain: 1, effective_priority: "HIGH", added_date: "2026-01-01", full_brief: "X".repeat(50), source_id: null, effective_archived: false, jurisdiction_iso: ["EU"] });
  // The listing reader ranges the rpc the way PostgREST does; the in-memory client answers a plain promise, so the stand-in adds `range`.
  const user = scripted.user;
  scripted.user = (request) => {
    const client = user!(request) as unknown as { rpc: (n: string, a?: unknown) => Promise<unknown> };
    const rpc = client.rpc.bind(client);
    client.rpc = (n, a) => Object.assign(rpc(n, a), { range: () => rpc(n, a) });
    return client as never;
  };
  db.rpcs.get_workspace_intelligence_listings = () => [row(ITEM_1, "o3"), row("aaaaaaaa-0000-4000-8000-0000000000aa", null)] as never;
  assert.equal((await call(rest, "anon", "GET", "/api/listings/rest?surface=regulations")).status, 401);
  assert.equal((await call(rest, "member", "GET", "/api/listings/rest?surface=nope")).status, 400);
  const ok = await call(rest, "member", "GET", "/api/listings/rest?surface=regulations");
  assert.equal(ok.status, 200);
  const rows = ok.body.resources as Array<{ id: string; uuid: string | null; fullBrief?: string }>;
  assert.deepEqual(rows.map((r) => [r.id, r.uuid]), [["o3", ITEM_1], ["aaaaaaaa-0000-4000-8000-0000000000aa", "aaaaaaaa-0000-4000-8000-0000000000aa"]], "the uuid rides with a legacy-id row (the workspace tags are keyed by it)");
  assert.ok(rows.every((r) => r.fullBrief === undefined), "a list row never carries the brief");
  db.rpcs.get_workspace_intelligence_listings = () => {
    throw new Error("rpc down");
  };
  const failed = await call(rest, "member", "GET", "/api/listings/rest?surface=regulations");
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("Retry-After"), "1");
  assert.equal(ORG_A.length, 36);
});

test("saved views: a database without the table answers a stated, retryable state on every verb, never a raw relation error", async () => {
  const db = script(seed());
  db.fail("saved_views", "select", { message: 'relation "public.saved_views" does not exist', code: "42P01" });
  db.fail("saved_views", "insert", { message: "relation does not exist", code: "42P01" });
  db.fail("saved_views", "delete", { message: "relation does not exist", code: "PGRST205" });
  const got = await call(listViews, "member", "GET", `${VIEWS}?surface=regulations`);
  assert.equal(got.status, 503);
  assert.equal(got.headers.get("Retry-After"), "60");
  assert.match(String(got.body.error), /not available yet/);
  assert.ok(!/relation/.test(String(got.body.error)), "no raw database text reaches the reader");
  assert.equal((await call(removeView, "member", "DELETE", `${VIEWS}?id=eeeeeeee-0000-4000-8000-000000000001`)).status, 503);
  assert.equal((await call(saveView, "member", "POST", VIEWS, { surface: "regulations", name: "x", query: "band=action" })).status, 503);
});

test("saved views: signed-in callers only; personal per user (another user's views are neither listed nor deletable); the stored query is the list's canonical one; names and caps are enforced", async () => {
  const matrix = { anon: 401, viewer: 200, member: 200, admin: 200, owner: 200, otherOrgMember: 200, platformAdmin: 200 };
  for (const [persona, status] of Object.entries(matrix)) {
    script(seed());
    assert.equal((await call(listViews, persona as never, "GET", `${VIEWS}?surface=regulations`)).status, status, `GET as ${persona}`);
  }
  const db = script(seed());
  (db.opts as { returnRows?: boolean }).returnRows = true; // PostgREST returns the rows of `.select()` after a write
  const made = await call(saveView, "member", "POST", VIEWS, { surface: "regulations", name: "  Immediate EU ", query: "?band=immediate&region=EU&evil=1" });
  assert.equal(made.status, 201);
  const view = made.body.view as { id: string; name: string; query: string };
  assert.deepEqual([view.name, view.query], ["Immediate EU", "band=immediate&region=EU"], "trimmed name, canonical query");
  assert.equal(db.rows("saved_views")[0]?.user_id, USER.member);
  // Personal: the owner of the same workspace sees none of it and cannot delete it.
  assert.deepEqual((await call(listViews, "owner", "GET", `${VIEWS}?surface=regulations`)).body.views, []);
  assert.equal((await call(removeView, "owner", "DELETE", `${VIEWS}?id=${view.id}`)).status, 404);
  assert.equal(db.rows("saved_views").length, 1);
  assert.equal((await call(listViews, "member", "GET", `${VIEWS}?surface=regulations`)).body.views instanceof Array, true);
  assert.equal(((await call(listViews, "member", "GET", `${VIEWS}?surface=regulations`)).body.views as unknown[]).length, 1);
  assert.equal((await call(removeView, "member", "DELETE", `${VIEWS}?id=${view.id}`)).status, 200);
  assert.equal(db.rows("saved_views").length, 0);
  // Validation: nothing to save, a bad surface, an empty name, a duplicate name, the cap.
  assert.equal((await call(saveView, "member", "POST", VIEWS, { surface: "regulations", name: "x", query: "evil=1" })).status, 400);
  assert.equal((await call(saveView, "member", "POST", VIEWS, { surface: "nowhere", name: "x", query: "band=action" })).status, 400);
  assert.equal((await call(saveView, "member", "POST", VIEWS, { surface: "regulations", name: "   ", query: "band=action" })).status, 400);
  db.fail("saved_views", "insert", { message: "duplicate key", code: "23505" }, { times: 1 });
  assert.equal((await call(saveView, "member", "POST", VIEWS, { surface: "regulations", name: "Dup", query: "band=action" })).status, 409);
  for (let i = 0; i < MAX_VIEWS_PER_SURFACE; i += 1) db.rows("saved_views").push({ id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`, user_id: USER.member, surface: "regulations", name: `v${i}`, query: "band=action", created_at: "2026-10-01T00:00:00Z" });
  assert.equal((await call(saveView, "member", "POST", VIEWS, { surface: "regulations", name: "One more", query: "band=action" })).status, 400);
  assert.equal((await call(removeView, "member", "DELETE", `${VIEWS}?id=not-a-uuid`)).status, 400);
});
