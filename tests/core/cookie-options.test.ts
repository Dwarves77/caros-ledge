// Audit 2.3.8: the session cookie carries Secure and SameSite=Lax on all three clients (the proxy's and the route's server clients, and the browser client), from one helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cookieOptions } from "@/core/db/cookie-options";

test("cookieOptions: Secure, SameSite=Lax, path /, and a fresh object each call", () => {
  assert.deepEqual(cookieOptions(), { secure: true, sameSite: "lax", path: "/" });
  assert.notEqual(cookieOptions(), cookieOptions(), "a client that mutates its options cannot change another's");
});

test("every Supabase cookie client is built with cookieOptions(): both server clients in clients.ts and the browser client", () => {
  const count = (file: string, factory: string) => {
    const text = readFileSync(file, "utf8");
    const calls = [...text.matchAll(new RegExp(`${factory}\\(`, "g"))].length;
    const withOptions = [...text.matchAll(/cookieOptions: cookieOptions\(\)/g)].length;
    return [calls, withOptions];
  };
  assert.deepEqual(count("src/core/db/clients.ts", "createServerClient"), [2, 2]);
  assert.deepEqual(count("src/core/db/browser.ts", "createBrowserClient"), [1, 1]);
});
