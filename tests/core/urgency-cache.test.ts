import assert from "node:assert/strict";
import { test } from "node:test";

import { cachedRead, type CacheStore } from "@/core/cache";
import { urgencyScore } from "@/core/urgency/scoring";

const base = { daysToNext: null, jurisdiction: "eu", verticals: [] as string[] };

test("BUILD-PLAN ruling 6: the composite is priority x time x jurisdiction x sector; LOW weighs 1, an unknown priority weighs as LOW, an unscored item is never zero", () => {
  const score = (priority: string | null) => urgencyScore({ ...base, priority });
  assert.deepEqual(["CRITICAL", "HIGH", "MODERATE", "LOW"].map(score), [4, 3, 2, 1], "eu weighs 1, so the product is the priority weight");
  assert.equal(score("LOW"), 1, "the LOW weight is stated, not a falsy fallback (the old `{LOW:0}[p] || 1`)");
  assert.equal(score(null), 1);
  assert.equal(score("whatever"), 1);
  assert.equal(urgencyScore({ ...base, priority: "HIGH", impact: { cost: 3, compliance: 3, client: 3, operational: 3 } }), 6, "a full stored impact (12 of 12) doubles the score");
  assert.ok(urgencyScore({ ...base, priority: "HIGH", impact: null }) > 0);
});

test("the time weight is 365 / days capped at 5 and floored at one day; no date weighs 1", () => {
  const at = (daysToNext: number | null) => urgencyScore({ ...base, priority: "LOW", daysToNext });
  assert.equal(at(null), 1);
  assert.equal(at(365), 1);
  assert.equal(at(73), 5);
  assert.equal(at(1), 5, "capped");
  assert.equal(at(0), 5, "today is one day, not infinity");
  assert.equal(at(730), 0.5);
});

test("the jurisdiction weight: platform default, a workspace override on top, 0.5 for one no table names, case-insensitive", () => {
  const at = (jurisdiction: string | null, ctx = {}) => urgencyScore({ priority: "CRITICAL", daysToNext: null, jurisdiction, verticals: [] }, ctx);
  assert.equal(at("EU"), 4);
  assert.equal(at("US"), 3.8, "us weighs 0.9: 4 x (0.5 + 0.9 x 0.5)");
  assert.equal(at("atlantis"), 3, "an unlisted jurisdiction weighs 0.5: 4 x (0.5 + 0.5 x 0.5)");
  assert.equal(at("us", { jurisdictionWeights: { us: 0 } }), 2, "the workspace's own weight wins");
  assert.equal(at(null), 4, "no jurisdiction reads as global");
});

test("the sector weight: 1 for no profile, 1 direct, 0.6 for a general rule, 0.3 adjacent, 0.1 unrelated", () => {
  const sector = (verticals: string[], sectors: string[]) => urgencyScore({ ...base, priority: "CRITICAL", verticals }, { sectors });
  assert.equal(sector(["fine-art"], []), 4);
  assert.equal(sector(["fine-art"], ["fine-art", "pharma"]), 4);
  assert.equal(sector([], ["fine-art"]), 2.4);
  assert.equal(sector(["luxury-goods"], ["fine-art"]), 1.2, "luxury goods are adjacent to fine art");
  assert.equal(sector(["mining-minerals"], ["fine-art"]), 0.4, "the same item ranks differently for another sector");
});

/** A map-backed stand-in for the cache underneath: an entry is stored only when the read resolved. */
function mapStore(): { store: CacheStore; hits: () => number; stored: () => number } {
  const kept = new Map<string, unknown>();
  let hit = 0;
  const store: CacheStore = (fn, key) => async () => {
    const k = key.join(":");
    if (kept.has(k)) {
      hit += 1;
      return kept.get(k) as never;
    }
    const value = await fn();
    kept.set(k, value);
    return value;
  };
  return { store, hits: () => hit, stored: () => kept.size };
}

test("cachedRead: a value is read once and kept; a throw is a stated failure and is NOT kept, so the next call reads again", async () => {
  const m = mapStore();
  let calls = 0;
  let fail = true;
  const read = async () => {
    calls += 1;
    if (fail) throw new Error("boom");
    return { rows: 3 };
  };
  const opts = { tags: ["t"], revalidate: 60, store: m.store };
  assert.deepEqual(await cachedRead(["k"], read, opts), { ok: false, error: "boom", timedOut: false });
  assert.equal(m.stored(), 0, "a failure is never cached");
  fail = false;
  assert.deepEqual(await cachedRead(["k"], read, opts), { ok: true, value: { rows: 3 } });
  assert.deepEqual(await cachedRead(["k"], read, opts), { ok: true, value: { rows: 3 } });
  assert.deepEqual([calls, m.hits()], [2, 1], "the third call was a cache hit");
});

test("cachedRead: a payload carrying _error is the fallback guard's to refuse (never stored), and a read past its deadline is timedOut", async () => {
  const m = mapStore();
  let calls = 0;
  const fallback = await cachedRead(["f"], async () => (calls += 1, { _error: "seed fallback", rows: [] }), { tags: [], revalidate: 60, store: m.store });
  assert.deepEqual(fallback, { ok: false, error: "seed fallback", timedOut: false });
  await cachedRead(["f"], async () => (calls += 1, { _error: "seed fallback", rows: [] }), { tags: [], revalidate: 60, store: m.store });
  assert.equal(calls, 2, "the fallback was read again, never served from the cache");
  const slow = await cachedRead(["s"], () => new Promise<never>(() => undefined), { tags: [], revalidate: 60, timeoutMs: 20, store: m.store });
  assert.deepEqual([slow.ok, slow.ok ? null : slow.timedOut], [false, true]);
});
