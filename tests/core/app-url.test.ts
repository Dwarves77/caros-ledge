// The app's own address (audit 2.3.7): invitation links are built from NEXT_PUBLIC_APP_URL and from nothing the request says. With it unset a route answers its 500 sentence, writes nothing and never reads Origin.
import assert from "node:assert/strict";
import { test } from "node:test";

import { appBaseUrl } from "@/core/http/app-url";
import { DB_SENTENCES } from "@/core/http/failure";
import { PUT } from "@/features/auth/api/members";
import { POST } from "@/features/auth/api/invitations";

import { fakeDb } from "../_support/fake-db.ts";
import { as, ctx, json, ORG_A, script } from "../_support/personas.ts";

/** Run `fn` with the named variables set (undefined deletes), restoring them after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => (x === undefined ? delete process.env[k] : (process.env[k] = x)));
  put(vars);
  try {
    return await fn();
  } finally {
    put(saved);
  }
}

test("appBaseUrl: https only (http outside production), no trailing slash, and a plain Error when it is unset or unusable", async () => {
  const url = (v: string | undefined, nodeEnv = "test") => withEnv({ NEXT_PUBLIC_APP_URL: v, NODE_ENV: nodeEnv }, () => appBaseUrl());
  assert.equal(await url("https://app.example.test"), "https://app.example.test");
  assert.equal(await url("https://app.example.test/"), "https://app.example.test");
  assert.equal(await url("http://localhost:3000"), "http://localhost:3000", "http is for a workstation");
  for (const [v, env] of [[undefined, "test"], ["", "test"], ["not a url", "test"], ["ftp://app.example.test", "test"], ["http://app.example.test", "production"], ["javascript:alert(1)", "test"]] as const) {
    await assert.rejects(async () => url(v, env), { message: "NEXT_PUBLIC_APP_URL is not configured" }, `${v} in ${env}`);
  }
});

test("POST invitations and PUT members with NEXT_PUBLIC_APP_URL unset: 500 with the stated sentence, no invitation written, the Origin header never read", async () => {
  for (const [name, handler, init] of [
    ["invitations POST", POST, { method: "POST", body: json({ email: "x@y.test", role: "member" }) }],
    ["members PUT", PUT, { method: "PUT", body: json({ email: "x@y.test", role: "member" }) }],
  ] as const) {
    const asked: string[] = [];
    script(fakeDb(), undefined, (rpc) => (asked.push(rpc), { data: { id: "i" } }));
    const request = as("owner", `/api/orgs/${ORG_A}/${name.startsWith("members") ? "members" : "invitations"}`, { ...init, headers: { origin: "https://evil.example" } });
    const read: string[] = [];
    const headers = request.headers;
    Object.defineProperty(request, "headers", { value: new Proxy(headers, { get: (t, p) => (p === "get" ? (h: string) => (read.push(h.toLowerCase()), t.get(h)) : (typeof t[p as keyof Headers] === "function" ? (t[p as keyof Headers] as () => unknown).bind(t) : t[p as keyof Headers])) }) });
    const res = await withEnv({ NEXT_PUBLIC_APP_URL: undefined }, () => handler(request, ctx({ org_id: ORG_A }) as never));
    assert.equal(res.status, 500, name);
    assert.deepEqual(await res.json(), { error: DB_SENTENCES["500"] }, name);
    assert.equal(asked.includes("invite_member"), false, `${name}: nothing written`);
    assert.equal(read.includes("origin"), false, `${name}: Origin is not consulted`);
  }
});

test("POST invitations builds the link from NEXT_PUBLIC_APP_URL even when the request names another origin", async () => {
  script(fakeDb(), undefined, (rpc) => (rpc === "invite_member" ? { data: { id: "i", token_last4: "abcd", invited_email: "x@y.test", proposed_role: "member", expires_at: "2099-01-01", status: "pending", created_at: "2026-01-01" } } : undefined));
  const res = await POST(as("owner", `/api/orgs/${ORG_A}/invitations`, { method: "POST", body: json({ email: "x@y.test", role: "member" }), headers: { origin: "https://evil.example" } }), ctx({ org_id: ORG_A }) as never);
  assert.equal(res.status, 201);
  const link = (await res.json()).invitation.invite_url as string;
  assert.match(link, /^https:\/\/app\.example\.test\/invitations\/[0-9a-f]{64}$/);
});
