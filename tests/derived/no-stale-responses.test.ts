// A browser reusing a 60-second response is a stale value by another route: the GET APIs that sent max-age or stale-while-revalidate send `private, no-store`, proven on each route's own answer, and no
// module in src sends a Cache-Control that lets a response be reused.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GET as matrixGet } from "@/features/dashboard/api/coverage-matrix";
import { GET as entriesGet } from "@/features/coverage/api/entries";

import { scripted } from "../_support/fake-clients.ts";
import { memoryDb } from "../_support/memory-db.ts";
import { as, ctx, personaOf, userDbFor } from "../_support/personas.ts";

const census = (id: string) => ({ id, document_url: `https://x.test/${id}`, instrument_identifier: id, title: `T ${id}`, source_id: "s1", shape_class: "law", surface_tags: ["regulations"], notes: "type=regulation", identity_checked_at: "2026-10-15T10:00:00.000Z", identity_resolves: true, identity_scheme: "celex", identity_shape_valid: true, identity_host_registered: true, dryrun_disposition: "would_mint", sources: { jurisdiction_iso: ["eu"], transport_modes: ["air"] } });

test("the coverage matrix and the coverage entries (the register is held in tests/connect/obligations.test.ts) answer `private, no-store`, never a reusable response", async () => {
  const service = memoryDb({ census_worklist: [census("a")], intelligence_items: [] });
  scripted.user = (request) => userDbFor(personaOf(request)).db;
  scripted.service = () => service.db;
  const matrix = await matrixGet(as("member", "/api/dashboard/coverage/matrix"), ctx({}) as never);
  assert.equal(matrix.status, 200);
  assert.equal(matrix.headers.get("cache-control"), "private, no-store");
  const csv = await matrixGet(as("member", "/api/dashboard/coverage/matrix?format=csv"), ctx({}) as never);
  assert.equal(csv.headers.get("cache-control"), "private, no-store");
  const entries = await entriesGet(as("platformAdmin", "/api/coverage/entries"), ctx({}) as never);
  assert.equal(entries.status, 200);
  assert.equal(entries.headers.get("cache-control"), "private, no-store");
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : []; });

test("no module in src sends a Cache-Control that lets a browser reuse a response (max-age, s-maxage, stale-while-revalidate, public)", () => {
  const REUSABLE = /max-age=[1-9]|s-maxage|stale-while-revalidate|Cache-Control["']?\s*[:,]\s*["'`]public/i;
  const code = (f: string) => readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const offenders = walk("src").filter((f) => REUSABLE.test(code(f))).map((f) => f.replace(/\\/g, "/"));
  assert.deepEqual(offenders, [], "a response is never drawn from a browser's copy");
  assert.ok(REUSABLE.test('"Cache-Control": "private, max-age=60"') && REUSABLE.test("stale-while-revalidate=120"), "the planted violations are flagged");
});
