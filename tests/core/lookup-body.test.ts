// A 503 answers the customer in one sentence. The driver's message (a table name, a relation error, a connection string's host) goes to the log, never into the body: for the core LookupError at its home, through
// the route wrapper and the guard, and for every handler in src by the one rule that no 5xx construction interpolates a database message into a 503.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ClaimsUnavailable } from "@/core/auth/claims";
import { answer, HttpError, LOOKUP_SENTENCE, LookupError, route } from "@/core/http/errors";
import { requireUser } from "@/core/http/guard";

import { scripted } from "../_support/fake-clients.ts";

const DRIVER = 'relation "public.secret_table" does not exist (host db.internal.example:5432)';

test("a LookupError answers the customer's sentence with Retry-After; the driver message is not in the body", async () => {
  const handler = route("/api/x", async () => {
    throw new LookupError("secret_table", { message: DRIVER });
  });
  const res = await handler(new Request("https://app.example.test/api/x"), undefined);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "1");
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: LOOKUP_SENTENCE });
  assert.ok(!text.includes("secret_table") && !text.includes("db.internal"), text);
  const e = new LookupError("secret_table", { message: DRIVER });
  assert.match(e.message, /lookup failed at secret_table: relation/, "the thrown error keeps the detail for the log and for callers that catch it");
  assert.equal(answer(new HttpError(409, "That name is taken")).status, 409);
  assert.equal(((await answer(new HttpError(409, "That name is taken")).json()) as { error: string }).error, "That name is taken", "an HttpError that is not a lookup says what it says");
});

test("the guard answers a failed claims or admin lookup with the same sentence", async () => {
  scripted.user = () => ({ auth: { getClaims: async () => { throw new ClaimsUnavailable({ message: DRIVER }); } } }) as never;
  const res = await requireUser(new Request("https://app.example.test/api/x", { headers: { authorization: "Bearer t" } }));
  assert.ok(res instanceof Response);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: LOOKUP_SENTENCE });
});

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

test("no handler in src builds a 503 from a database message (the rule, over every surface)", () => {
  const offenders: string[] = [];
  for (const file of walk(join(process.cwd(), "src"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const builds503 = /HttpError\(503|refuse\(503|status: 503/.test(line);
      if (builds503 && /\.message|describeError|detail:\s*[a-z]+\.error|\$\{error\b/.test(line) && !/LOOKUP_SENTENCE/.test(line)) offenders.push(`${file.replace(process.cwd(), "").replaceAll("\\", "/")}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
