// FIX-QUOTE-1: the stored-quote lookup asks the database once per distinct (url, quote) within a run and reads each capture's text once, and the verbatim rule is exactly what it was: a quote the capture does not hold is
// refused, cached or not. (The SQL half, the cited URL's captures tested first and indexed, is migration 0132's self-check.)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Db } from "@/core/db";
import { acceptStoredQuote } from "@/core/producers/quote";

import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";
import { MemDb } from "../_support/memdb.ts";

const URL_A = "https://agency.example/rule-a";
const TEXT_A = "Article 4 states a limit of 91,16 grams per MJ. Article 5 follows with a second sentence.";
const NOW = new Date("2026-10-20T00:00:00Z");

/** A world of 50 captures of other URLs that hold the same sentences, and one of the cited URL; the client counts the rpc calls and the capture-text reads it serves. */
function world() {
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [{ id: "i1" }]);
  db.seed("agent_run_searches", [
    ...Array.from({ length: 50 }, (_, n) => ({ id: `other-${n}`, intelligence_item_id: "i1", result_url: `https://elsewhere.example/page-${n}`, result_content: TEXT_A, result_index: n })),
    { id: "cap-a", intelligence_item_id: "i1", result_url: URL_A, result_content: TEXT_A, result_index: 99 },
  ]);
  db.seed("sources", [{ id: "s1", url: URL_A, base_tier: 3, status: "active", reuse_terms: "licensed" }]);
  const seen = { rpc: 0, textReads: 0 };
  const sb = new Proxy(db.client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "rpc") return (...a: unknown[]) => ((seen.rpc += 1), (v as (...x: unknown[]) => unknown).apply(target, a));
      if (prop === "from")
        return (table: string, ...rest: unknown[]) => {
          const q = (v as (...x: unknown[]) => { select: (...x: unknown[]) => unknown }).call(target, table, ...rest);
          if (table !== "agent_run_searches") return q;
          return new Proxy(q, { get: (t, p, r) => (p === "select" ? (...a: unknown[]) => (String(a[0]).includes("result_content") && (seen.textReads += 1), (t.select as (...x: unknown[]) => unknown)(...a)) : Reflect.get(t, p, r)) });
        };
      return v;
    },
  }) as unknown as Db;
  return { db, sb, seen };
}
const ask = (sb: Db, quote: string, cache?: { texts: Map<string, string>; found: Map<string, string | null> }) =>
  acceptStoredQuote(sb, { url: URL_A, quote, verifiedAt: "2026-10-01", now: NOW }, cache?.texts, cache?.found);

test("the same (url, quote) asked again in a run asks the database once and reads the capture once; a different quote of the same page asks again but reads no second copy", async () => {
  const w = world();
  const cache = { texts: new Map<string, string>(), found: new Map<string, string | null>() };
  const first = await ask(w.sb, "a limit of 91,16 grams", cache);
  const second = await ask(w.sb, "a limit of 91,16 grams", cache);
  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.deepEqual([w.seen.rpc, w.seen.textReads], [1, 1]);
  assert.equal((await ask(w.sb, "Article 5 follows", cache)).ok, true);
  assert.deepEqual([w.seen.rpc, w.seen.textReads], [2, 1], "a second quote is a second question; the capture text is already held");
  assert.equal(first.ok && first.captureId, "cap-a", "the cited URL's capture, never another URL's");
});

test("with no cache every call asks (the shape the statutory rows path and the corrections path had)", async () => {
  const w = world();
  await ask(w.sb, "a limit of 91,16 grams");
  await ask(w.sb, "a limit of 91,16 grams");
  assert.equal(w.seen.rpc, 2);
});

test("the verbatim rule is unchanged: a quote the capture does not hold is refused, by the database answer and again from the cache, and a refusal is not turned into an acceptance by the cache", async () => {
  const w = world();
  const cache = { texts: new Map<string, string>(), found: new Map<string, string | null>() };
  for (let asked = 0; asked < 2; asked += 1) {
    const v = await ask(w.sb, "a limit of 99 grams per MJ", cache);
    assert.deepEqual([v.ok, v.ok ? null : v.reason], [false, "quote_not_in_capture"]);
  }
  assert.equal(w.seen.rpc, 1, "the miss is remembered for the run");
  assert.equal((await ask(w.sb, "A LIMIT OF 91,16 GRAMS", cache)).ok, true, "case-insensitive, as the rule always was");
  assert.equal((await ask(w.sb, "   ", cache)).ok, false);
});
