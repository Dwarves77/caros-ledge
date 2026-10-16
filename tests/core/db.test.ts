import assert from "node:assert/strict";
import { test } from "node:test";

import { boundedRead, fetchAllByIdChunks, fetchAllRows, keyset, ReadTimeoutError, unwrap, withTimeout } from "@/core/db/query";
import { SCHEMA_KEYS } from "@/core/db/schema-keys";

import * as real from "../../src/core/db/clients.ts";

const withEnv = (patch: Record<string, string | undefined>, run: () => void) => {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(patch);
  try {
    run();
  } finally {
    apply(before);
  }
};

test("PROP-011/109: the service client never downgrades to the anon key", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined }, () => assert.throws(() => real.serviceClient(), /fail-closed/));
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }, () => assert.throws(() => real.serviceClient(), /fail-closed/));
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY }, () => assert.throws(() => real.serviceClient(), /equals the anon key/));
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: "service-placeholder" }, () => assert.ok(real.serviceClient()));
  // memoised: the second call is the same instance and never rebuilds from a changed environment
  assert.equal(real.serviceClient(), real.serviceClient());
});

test("userClient with a bearer builds an RLS client from the caller's token only", async () => {
  const request = new Request("https://x.test", { headers: { authorization: "Bearer abc" } });
  assert.equal(real.bearerToken(request), "abc");
  assert.equal(real.bearerToken(new Request("https://x.test", { headers: { authorization: "Basic abc" } })), null);
  assert.ok(await real.userClient(request));
});

test("boundedRead: the bound is a hard ceiling of 200 and a failure is a value, never an empty list", async () => {
  await assert.rejects(boundedRead(async () => ({ data: [], error: null }), { limit: 201 }), RangeError);
  await assert.rejects(boundedRead(async () => ({ data: [], error: null }), { limit: 0 }), RangeError);
  const ok = await boundedRead(async (limit) => ({ data: [1, 2].slice(0, limit), error: null }), { limit: 5 });
  assert.deepEqual(ok, { data: [1, 2], truncated: false, error: null });
  const full = await boundedRead(async () => ({ data: [1, 2], error: null }), { limit: 2 });
  assert.equal(full.truncated, true);
  const failed = await boundedRead(async () => ({ data: null, error: { message: "boom", code: "XX000" } }), { limit: 5 });
  assert.equal(failed.data, null);
  assert.equal(failed.error?.code, "XX000");
  const over = await boundedRead(async () => ({ data: [1, 2, 3], error: null }), { limit: 2 });
  assert.match(over.error?.message ?? "", /past its 2-row bound/);
  const slow = await boundedRead(() => new Promise<never>(() => undefined), { limit: 5, timeoutMs: 5 });
  assert.equal(slow.error?.timedOut, true);
  assert.throws(() => unwrap(failed), /boom/);
});

test("withTimeout clears its timer on success and on failure, and rejects on the deadline", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  assert.equal(await withTimeout(Promise.resolve(7), 60_000), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("x")), 60_000), /x/);
  assert.equal(timers(), before);
  await assert.rejects(withTimeout(new Promise(() => undefined), 5), ReadTimeoutError);
});

test("keyset paging: limit + 1 rows prove a next page and the cursor round-trips", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const page = keyset.page(rows, 2, (r) => [r.id]);
  assert.deepEqual(page.rows.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(keyset.decode(page.next), ["b"]);
  assert.equal(keyset.page(rows, 3, (r) => [r.id]).next, null);
  assert.equal(keyset.decode("not-a-cursor!!"), null);
  assert.equal(keyset.decode(null), null);
});

test("fetchAllRows pages until a short page, throws on any page error, and honours its cap", async () => {
  const data = Array.from({ length: 25 }, (_, i) => i);
  const factory = async (from: number, to: number) => ({ data: data.slice(from, to + 1), error: null });
  assert.deepEqual(await fetchAllRows(factory, { pageSize: 10 }), data);
  await assert.rejects(fetchAllRows(async () => ({ data: null, error: { message: "page failed" } })), /failed at offset 0: page failed/);
  await assert.rejects(fetchAllRows(factory, { pageSize: 10, cap: 20 }), /exceeded its cap/);
});

test("fetchAllByIdChunks chunks the ids and refuses a widened filter", async () => {
  const seen: string[][] = [];
  const out = await fetchAllByIdChunks(["a", "b", "a", "c"], async (slice) => (seen.push(slice), slice), { chunk: 2 });
  assert.deepEqual(seen, [["a", "b"], ["c"]]);
  assert.deepEqual(out, ["a", "b", "c"]);
  await assert.rejects(fetchAllByIdChunks(["a"], async () => ["a", "a"]), /cannot return more/);
});

test("the committed schema-keys file is the generator's output for supabase/schema.sql and the forward migrations", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const sql = readFileSync("supabase/schema.sql", "utf8");
  const keys: Record<string, string[]> = {};
  for (const [, table, cols] of sql.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\);/g)) keys[table!] = cols!.split(",").map((c) => c.trim());
  for (const f of readdirSync("supabase/migrations").filter((x) => /^\d{4}_.+\.sql$/.test(x) && !x.includes("_data_")).sort()) {
    const text = readFileSync(`supabase/migrations/${f}`, "utf8");
    for (const [, table, cols] of text.matchAll(/ALTER TABLE (?:ONLY )?public\.(\w+)[^;]*?ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\)/g)) keys[table!] = cols!.split(",").map((c) => c.trim());
  }
  assert.deepEqual(SCHEMA_KEYS, Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b))));
  assert.deepEqual(SCHEMA_KEYS.profiles, ["id"]);
});
