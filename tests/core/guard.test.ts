import assert from "node:assert/strict";
import { test } from "node:test";

import { isRefusal, requireAdmin, requireOrgRole, requireUser, workerAuthGuard } from "@/core/http/guard";

import { scripted } from "../_support/fake-clients.ts";
import { fakeDb, signedIn, signedOut } from "../_support/fake-db.ts";
import { as, ORG_A, ORG_B, script } from "../_support/personas.ts";

const status = async (r: unknown) => (isRefusal(r) ? r.status : 0);

test("requireUser: bearer or cookie, 401 for no or bad credentials", async () => {
  script(fakeDb());
  assert.equal(await status(await requireUser(as("anon", "/api/x"))), 401);
  const user = await requireUser(as("member", "/api/x"));
  assert.ok(!isRefusal(user) && user.userId === "u-member" && "X-RateLimit-Limit" in user.headers);
  // an expired or malformed token: getClaims answers an error, which is "not signed in", not an outage
  scripted.user = () => fakeDb(undefined, { claims: { data: null, error: { name: "AuthApiError", message: "invalid JWT" } } }).db;
  const bad = await requireUser(as("member", "/api/x"));
  assert.ok(isRefusal(bad) && bad.status === 401);
  assert.deepEqual(await bad.json(), { error: "Invalid or expired token" });
});

test("requireUser: an auth-service failure is a 503 with Retry-After, never a 401", async () => {
  scripted.user = () => fakeDb(undefined, { claims: { data: null, error: { name: "AuthRetryableFetchError", message: "fetch failed" } } }).db;
  const outage = await requireUser(as("member", "/api/x"));
  assert.ok(isRefusal(outage) && outage.status === 503 && outage.headers.get("Retry-After") === "1");
  scripted.user = () => fakeDb(undefined, { claims: () => Promise.reject(new Error("socket hang up")) }).db;
  assert.equal(await status(await requireUser(as("member", "/api/x"))), 503);
});

test("requireUser: not configured is a 500", async () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    assert.equal(await status(await requireUser(as("member", "/api/x"))), 500);
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  }
});

test("requireAdmin (PROP-001/160): only the own-row rpc admits; a failed read is a 503, not a 403", async () => {
  script(fakeDb());
  assert.equal(await status(await requireAdmin(as("anon", "/api/admin/x"))), 401);
  for (const persona of ["viewer", "member", "owner", "otherOrgMember"] as const) assert.equal(await status(await requireAdmin(as(persona, "/api/admin/x"))), 403, persona);
  const admin = await requireAdmin(as("platformAdmin", "/api/admin/x"));
  assert.ok(!isRefusal(admin) && typeof admin.service === "function");
  scripted.user = () => fakeDb(undefined, { claims: signedIn("u-admin"), rpc: () => ({ error: { message: "rpc down" } }) }).db;
  assert.equal(await status(await requireAdmin(as("platformAdmin", "/api/admin/x"))), 503);
});

test("requireOrgRole: the oldest-membership rule, role ranks, viewers are read-only", async () => {
  script(fakeDb());
  assert.equal(await status(await requireOrgRole(as("anon", "/x"), "member")), 401);
  assert.equal(await status(await requireOrgRole(as("platformAdmin", "/x"), "viewer")), 403, "no membership");
  assert.equal(await status(await requireOrgRole(as("otherOrgMember", "/x"), "viewer", ORG_A)), 403, "membership of another org");
  const viewerWrite = await requireOrgRole(as("viewer", "/x"), "member");
  assert.ok(isRefusal(viewerWrite) && (await viewerWrite.json()).error === "viewer_read_only");
  assert.equal(await status(await requireOrgRole(as("member", "/x"), "owner", ORG_A)), 403);
  const owner = await requireOrgRole(as("owner", "/x"), "owner");
  assert.ok(!isRefusal(owner) && owner.membership.orgId === ORG_A && owner.membership.role === "owner");
  const other = await requireOrgRole(as("otherOrgMember", "/x"), "member");
  assert.ok(!isRefusal(other) && other.membership.orgId === ORG_B);
});

test("requireOrgRole: a failed membership read is a 503 (fail-open guard reads are the defect)", async () => {
  scripted.user = () => fakeDb((c) => (c.table === "org_memberships" ? { error: { message: "db down" } } : undefined), { claims: signedIn("u1") }).db;
  assert.equal(await status(await requireOrgRole(as("member", "/x"), "viewer")), 503);
  scripted.user = () => fakeDb(undefined, { claims: signedOut }).db;
  assert.equal(await status(await requireOrgRole(as("anon", "/x"), "viewer")), 401);
});

test("workerAuthGuard: constant-time secret check, fail closed when unset", () => {
  const saved = process.env.WORKER_SECRET;
  try {
    delete process.env.WORKER_SECRET;
    assert.equal(workerAuthGuard(new Request("https://x.test"))?.status, 500);
    process.env.WORKER_SECRET = "s3cret";
    assert.equal(workerAuthGuard(new Request("https://x.test"))?.status, 401);
    assert.equal(workerAuthGuard(new Request("https://x.test", { headers: { "x-worker-secret": "s3cre" } }))?.status, 401);
    assert.equal(workerAuthGuard(new Request("https://x.test", { headers: { authorization: "Bearer s3cret" } }))?.status, 401, "no bearer path");
    assert.equal(workerAuthGuard(new Request("https://x.test", { headers: { "x-worker-secret": "s3cret" } })), null);
  } finally {
    if (saved === undefined) delete process.env.WORKER_SECRET;
    else process.env.WORKER_SECRET = saved;
  }
});
