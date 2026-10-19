// R2e M5: deleting and exporting one's own account. The database function does the work and is proven by its own attack (migration 0104: deleting A leaves every row of B as it was); this file proves the ROUTES: both act on the
// session and take no account id (a body that names one is refused, INV-R2e-4), both are behind the same per-user limit as the identity route, the export is the typed schema's parse of the function's answer, and an absent function is a
// stated block.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DELETE, GET_EXPORT } from "@/features/auth/api/account";
import { accountExport } from "@/features/auth/lib/account-export";

import { fakeDb, type Reply } from "../_support/fake-db.ts";
import { as, PERSONAS, script, type Persona } from "../_support/personas.ts";

const SAMPLE = JSON.parse(readFileSync("tests/auth/fixtures/export-sample.json", "utf8")) as Record<string, unknown>;
const CONFIRM = { confirm: "delete my account" };

function world(rpc: (name: string, args: unknown) => Reply | undefined) {
  const service = fakeDb();
  script(service, undefined, rpc);
  const run = async (handler: (r: Request, c: never) => Promise<Response>, persona: Persona, init: RequestInit = {}) => {
    const res = await handler(as(persona, "/api/account", init), { params: Promise.resolve({}) } as never);
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { service, run };
}

test("the export schema accepts the real function's answer (captured from migration 0104 on the schema job's database) and strips anything it does not name", () => {
  const parsed = accountExport.parse({ ...SAMPLE, internal_cost: 12, profile: { ...(SAMPLE.profile as object), linkedin_sub: "secret-subject", org_id: "internal" } });
  assert.equal("internal_cost" in parsed, false, "a section the schema does not name is not in the response");
  assert.equal("linkedin_sub" in (parsed.profile ?? {}), false, "a column of the profile row the schema does not name is not in the response");
  assert.equal(parsed.profile?.full_name, "Ann Example");
  assert.equal(parsed.notes[0]?.body, "check the Q4 deadline");
  assert.equal(parsed.community.posts[0]?.title, "A thread");
  assert.equal(parsed.assignments[0]?.assigned_to_me, false, "who the member assigned is a flag, never the other person");
  assert.equal(parsed.invitations_issued_count, 1);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(SAMPLE).sort(), "every section of the answer is named in the schema");
  assert.throws(() => accountExport.parse({ ...SAMPLE, memberships: "nope" }), "a shape the schema does not expect is refused, not passed through");
});

test("GET /api/account/export: the persona matrix; the response is the schema's parse, sent as a file, never cached; the function takes no argument", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const { run } = world((name, args) => {
    calls.push({ name, args });
    return name === "export_own_account" ? { data: { ...SAMPLE, internal_cost: 12 } } : undefined;
  });
  for (const persona of PERSONAS) assert.equal((await run(GET_EXPORT, persona)).status, persona === "anon" ? 401 : 200, persona);
  const res = await run(GET_EXPORT, "member");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="caros-ledge-account-export\.json"/);
  assert.equal("internal_cost" in res.body, false);
  assert.equal((res.body.profile as { full_name: string }).full_name, "Ann Example");
  assert.ok(calls.every((c) => c.name === "export_own_account" && c.args === undefined), "the export asks for no account: it is the session's");
});

test("DELETE /api/account: member-only, the typed phrase is required, and a body that names another member's account is refused before the function runs (INV-R2e-4)", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const { run } = world((name, args) => {
    calls.push({ name, args });
    return name === "delete_own_account" ? { data: { organisations_deleted: 1, memberships_removed: 0, groups_deleted: 0, groups_handed_over: 1, posts_kept_unattributed: 2 } } : undefined;
  });
  for (const persona of PERSONAS) assert.equal((await run(DELETE, persona, { method: "DELETE", body: JSON.stringify(CONFIRM) })).status, persona === "anon" ? 401 : 200, persona);
  const before = calls.length;
  const ok = await run(DELETE, "member", { method: "DELETE", body: JSON.stringify(CONFIRM) });
  assert.deepEqual(ok.body, { deleted: true, organisations_deleted: 1, memberships_removed: 0, groups_deleted: 0, groups_handed_over: 1, posts_kept_unattributed: 2 });
  assert.deepEqual(calls[calls.length - 1], { name: "delete_own_account", args: undefined }, "the function is called with no argument: it acts on the session");
  assert.equal(calls.length, before + 1);
  for (const attack of [{ ...CONFIRM, user_id: "u-owner" }, { ...CONFIRM, id: "u-owner" }, { ...CONFIRM, account_id: "u-owner" }, { confirm: "yes" }, {}]) {
    const refused = await run(DELETE, "member", { method: "DELETE", body: JSON.stringify(attack) });
    assert.equal(refused.status, 400, JSON.stringify(attack));
  }
  assert.equal((await run(DELETE, "member", { method: "DELETE" })).status, 400, "no body is no confirmation");
  assert.equal(calls.length, before + 1, "no refused request reached the function");
});

test("DELETE: the function's refusals reach the member in its own sentence (a sole owner of a shared organisation, a platform administrator); a failed call is a 503 that keeps the driver text in the log; an absent function is a stated block", async () => {
  const sole = 'You are the only owner of "Acme" and other people belong to it. Make someone else an owner, or remove the members, first.';
  const refused = await world(() => ({ error: { message: sole, code: "22023" } })).run(DELETE, "owner", { method: "DELETE", body: JSON.stringify(CONFIRM) });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, sole);
  const down = await world(() => ({ error: { message: 'insert or update on table "org_memberships" violates foreign key constraint', code: "23503" } })).run(DELETE, "member", { method: "DELETE", body: JSON.stringify(CONFIRM) });
  assert.equal(down.status, 503);
  assert.doesNotMatch(JSON.stringify(down.body), /org_memberships|foreign key/);
  const absent = await world(() => ({ error: { message: "function public.delete_own_account() does not exist", code: "42883" } })).run(DELETE, "member", { method: "DELETE", body: JSON.stringify(CONFIRM) });
  assert.equal(absent.status, 503, "before the migration is applied the route says so; it does not throw a page");
  assert.equal(absent.headers.get("Retry-After"), "30");
  const noExport = await world(() => ({ error: { message: "function public.export_own_account() does not exist", code: "42883" } })).run(GET_EXPORT, "member");
  assert.equal(noExport.status, 503);
});

test("both routes share the identity route's per-user limiter (requireUser) and use no service client", () => {
  const source = readFileSync("src/features/auth/api/account.ts", "utf8");
  assert.equal((source.match(/requireUser\(request\)/g) ?? []).length, 2, "each handler starts at the one guard that limits per user");
  assert.doesNotMatch(source, /serviceClient|service\(\)/, "SEC-3b: the account functions run on the caller's own client");
});
