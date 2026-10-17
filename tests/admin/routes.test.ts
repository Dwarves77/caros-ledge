import assert from "node:assert/strict";
import { test } from "node:test";

import { adminRoutes, hit } from "../_support/admin-routes.ts";
import { fakeDb } from "../_support/fake-db.ts";
import { PERSONAS, script } from "../_support/personas.ts";

test("every admin route (all methods) answers 401 to nobody, 403 to every signed-in non-admin, and lets only the platform admin past the guard", async () => {
  script(fakeDb(() => undefined));
  const all = await adminRoutes();
  assert.ok(all.length >= 34, `found the admin routes (${all.length})`);
  for (const r of all) {
    for (const persona of PERSONAS) {
      const got = await hit(r, persona);
      const label = `${r.method} ${r.path} as ${persona}`;
      if (persona === "anon") assert.equal(got, 401, label);
      else if (persona === "platformAdmin") assert.ok(got === "passed" || (got !== 401 && got !== 403), `${label} must pass the guard (${got})`);
      else assert.equal(got, 403, label);
    }
  }
});
