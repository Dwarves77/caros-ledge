// PROP-001 on the worker routes (no secret 401, wrong secret 401, right secret 200, the 61st request 429) and the persona matrix on the telemetry and version routes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { POST as checkSources } from "@/app/api/worker/check-sources/route";
import { GET as surfaces } from "@/app/api/health/surfaces/route";
import { GET as version } from "@/app/api/version/route";
import { POST as revalidate } from "@/app/api/revalidate/route";
import { POST as telemetryError } from "@/app/api/telemetry/error/route";

import { scripted } from "../_support/fake-clients.ts";
import { memoryDb } from "../_support/memory-db.ts";
import { as, json, personaOf, PERSONAS, userDbFor, type Persona } from "../_support/personas.ts";

process.env.WORKER_SECRET = "route-secret";
const withSecret = (url: string, secret: string | null, init: RequestInit = {}) =>
  new Request(`https://app.example.test${url}`, { method: "POST", ...init, headers: { "content-type": "application/json", ...(secret ? { "x-worker-secret": secret } : {}), ...(init.headers ?? {}) } });
const off = () => memoryDb({ system_state: [{ id: true, scrape_cadence: "off", scrape_start_date: null, global_processing_paused: false }] });

test("check-sources: a bad limit is a 400 before any state check, and a malformed body is a 400", async () => {
  const w = off();
  scripted.service = () => w.db;
  assert.equal((await surfacesLimit("?limit=abc")).status, 400);
  const bad = await checkSources(withSecret("/api/worker/check-sources", "route-secret", { body: "{nope" }));
  assert.equal(bad.status, 400);
  assert.equal(w.reads.length, 0, "no state read happened for a refused request");
});
test("PROP-001: check-sources: no secret 401, wrong secret 401, right secret 200 with 0 checked in build mode, the 61st request 429", async () => {
  const w = off();
  scripted.service = () => w.db;
  assert.equal((await checkSources(withSecret("/api/worker/check-sources", null))).status, 401);
  assert.equal((await checkSources(withSecret("/api/worker/check-sources", "wrong"))).status, 401);
  const first = await checkSources(withSecret("/api/worker/check-sources", "route-secret"));
  assert.equal(first.status, 200);
  const body = (await first.json()) as { checked: number; sourcesChecked: number };
  assert.equal(body.checked, 0);
  assert.equal(body.sourcesChecked, 0);
  assert.equal(w.writes.length, 0, "the gate exits before any write");
  const PRIOR = 2; // the two validation requests above passed the limiter before they were refused
  for (let i = PRIOR + 2; i <= 60; i++) assert.equal((await checkSources(withSecret("/api/worker/check-sources", "route-secret"))).status, 200, `request ${i}`);
  const limited = await checkSources(withSecret("/api/worker/check-sources", "route-secret"));
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("Retry-After"));
});
async function surfacesLimit(query: string) {
  return checkSources(withSecret(`/api/worker/check-sources${query}`, "route-secret"));
}

test("PROP-001: revalidate: no secret 401, wrong secret 401, bad tags 400, right secret 200", async () => {
  const post = (secret: string | null, body: unknown) => revalidate(withSecret("/api/revalidate", secret, { body: json(body) }));
  assert.equal((await post(null, { tags: ["intel-items"] })).status, 401);
  assert.equal((await post("wrong", { tags: ["intel-items"] })).status, 401);
  assert.equal((await post("route-secret", { tags: [] })).status, 400);
  assert.equal((await post("route-secret", { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) })).status, 400);
  assert.equal((await post("route-secret", { path: "/x" })).status, 400, "tags only, never a path");
});
test("PROP-001: health/surfaces: no secret 401, wrong secret 401, right secret answers 200 or 503 with the probe body", async () => {
  const w = memoryDb({ organizations: [{ id: "org-1", created_at: "2026-01-01" }] }, { rpc: (name) => (name === "get_all_surface_counts" ? { data: { total: { verified: 3 }, regulations: { verified: 2 }, market: { verified: 1 }, research: { verified: 1 }, operations: { verified: 1 } } } : { data: { error: "gate_a_health cache empty" } }) });
  scripted.service = () => w.db;
  const get = (secret: string | null) => surfaces(withSecret("/api/health/surfaces", secret, { method: "GET" }));
  assert.equal((await get(null)).status, 401);
  assert.equal((await get("wrong")).status, 401);
  const res = await get("route-secret");
  assert.ok([200, 503].includes(res.status));
  const body = (await res.json()) as { surfaces: Record<string, unknown>; gate_a: Record<string, { state: string }> };
  assert.ok(body.surfaces.dashboard);
  assert.equal(body.gate_a.invariant_violations?.state, "not_computed", "an empty cache is not_computed, never a bare zero");
});
test("health/surfaces: an unconfigured service client is a 500, not a pass", async () => {
  scripted.service = null;
  const res = await surfaces(withSecret("/api/health/surfaces", "route-secret", { method: "GET" }));
  assert.equal(res.status, 500);
  assert.equal(((await res.json()) as { ok: boolean }).ok, false);
});

test("telemetry/error persona matrix: anon is refused, every signed-in persona may report", async () => {
  const w = memoryDb();
  scripted.user = (request) => userDbFor(personaOf(request)).db;
  scripted.service = () => w.db;
  const statuses: Record<string, number> = {};
  for (const p of PERSONAS) statuses[p] = (await telemetryError(as(p as Persona, "/api/telemetry/error", { method: "POST", body: json({ message: "boom", path: "/x" }) }))).status;
  assert.equal(statuses.anon, 401);
  for (const p of PERSONAS.filter((x) => x !== "anon")) assert.equal(statuses[p], 204, p);
});
test("telemetry/error: a missing message and bad JSON are 400, an oversize body is 413", async () => {
  scripted.user = (request) => userDbFor(personaOf(request)).db;
  scripted.service = () => memoryDb().db;
  const post = (body: string) => telemetryError(as("member", "/api/telemetry/error", { method: "POST", body }));
  assert.equal((await post(json({ path: "/x" }))).status, 400);
  assert.equal((await post("{nope")).status, 400);
  assert.equal((await post(json({ message: "x".repeat(40_000) }))).status, 413);
});
test("telemetry/error: the report is stored without a user scope", async () => {
  const w = memoryDb();
  scripted.user = (request) => userDbFor(personaOf(request)).db;
  scripted.service = () => w.db;
  await telemetryError(as("member", "/api/telemetry/error", { method: "POST", body: json({ message: "kaboom a@b.test", path: "/dash" }) }));
  const row = w.tables.error_events?.[0];
  assert.ok(row);
  assert.equal(row.user_scope ?? null, null);
  assert.equal(String(row.message).includes("a@b.test"), false, "emails are redacted");
});

test("version: public, read-only, build metadata only", async () => {
  process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
  const res = version();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys((await res.json()) as object).sort(), ["commit", "env", "ref", "repo"]);
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});
