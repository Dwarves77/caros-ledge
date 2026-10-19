import assert from "node:assert/strict";
import { test } from "node:test";

import { readAttention } from "@/features/admin/api/attention";
import { resolveJurisdictionReview } from "@/features/admin/api/triage";
import { readDashboard } from "@/features/admin/read/dashboard";

import { fakeDb } from "../_support/fake-db.ts";
import { as, ctx, script } from "../_support/personas.ts";

// Production carries no new migration until cutover: the 0035 rpcs do not exist there yet. Every read or action that calls them fails closed into a stated block, never a thrown page or a silent zero.
const missing = (name: string) => ({ error: { code: "42883", message: `function public.${name}() does not exist` } });
const ID = "77777777-7777-4777-8777-777777777777";

test("an absent admin_attention_counts is a stated 503 naming the migration, and the dashboard part says so while the other parts still read", async () => {
  const w = fakeDb(() => undefined, { rpc: (name) => (name === "admin_attention_counts" ? missing(name) : undefined) });
  await assert.rejects(readAttention(w.db), (e: { status?: number; message?: string }) => e.status === 503 && /admin_attention_counts is not installed.*0035/.test(e.message ?? ""));
  const dash = await readDashboard(w.db, "2026-10-16T00:00:00.000Z");
  assert.equal(dash.attention.ok, false, "the attention part failed, it did not become zeros");
  assert.match(!dash.attention.ok ? dash.attention.error : "", /not installed/);
  assert.ok(dash.orgs.ok, "the parts that do not need the rpc still read");
});

test("an absent admin_resolve_jurisdiction_review refuses with the reason (503), writes nothing, and never throws a page", async () => {
  const w = fakeDb();
  script(w, undefined, (name) => (name === "admin_resolve_jurisdiction_review" ? missing(name) : undefined));
  const res = await resolveJurisdictionReview(as("platformAdmin", "/api/admin/triage/pending-jurisdiction-review", { method: "POST", body: JSON.stringify({ id: ID, action: "confirm", reason: "the token stands" }) }), ctx({}) as never);
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /admin_resolve_jurisdiction_review is not installed.*0102/);
  assert.equal(w.calls.filter((c) => c.op !== "select").length, 0, "no write happened");
});
