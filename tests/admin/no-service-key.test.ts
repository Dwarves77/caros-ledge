import assert from "node:assert/strict";
import { test } from "node:test";

import { adminRoutes } from "../_support/admin-routes.ts";
import { scripted } from "../_support/fake-clients.ts";
import { fakeDb } from "../_support/fake-db.ts";
import { as, ctx, script } from "../_support/personas.ts";

test("without a service key every admin read that needs the service role answers a stated 503 (a missing key is configuration, not a transient failure, so no Retry-After), and none answers an empty 200", async () => {
  script(fakeDb(() => undefined));
  scripted.service = null;
  const reads = (await adminRoutes()).filter((r) => r.method === "GET");
  const said: string[] = [];
  for (const r of reads) {
    const res = await r.handler(as("platformAdmin", r.path), ctx(r.params));
    assert.equal(res.status, 503, `${r.path} answered ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /service/i, `${r.path} says why`);
    said.push(r.path);
  }
  assert.ok(said.length >= 15, `${said.length} admin reads proven`);
});
