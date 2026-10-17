import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { loadMembership, membershipOf, resetMembership, setWatch } from "@/features/watchlist/membership";

type Call = Parameters<typeof loadMembership>[1];
const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as Call;

beforeEach(() => resetMembership());

test("a failed membership read is not kept: the state is failed (never an empty 'unwatched'), and the next read asks again", async () => {
  let asked = 0;
  const failing = (async () => (asked += 1, new Response("{}", { status: 500 }))) as unknown as Call;
  await loadMembership("reg", failing);
  assert.equal(membershipOf("reg")?.status, "failed");
  assert.deepEqual(membershipOf("reg")?.watched, []);
  await loadMembership("reg", reply(200, { watchedIds: ["a"], teamWatchedIds: [], teamAvailable: true }));
  assert.deepEqual([asked, membershipOf("reg")?.status, membershipOf("reg")?.watched], [1, "ready", ["a"]]);
  let again = 0;
  await loadMembership("reg", (async () => (again += 1, new Response("{}"))) as unknown as Call);
  assert.equal(again, 0, "a successful read is shared by every toggle of the type");
});

test("a thrown read is a failed state too", async () => {
  await loadMembership("reg", (async () => { throw new Error("offline"); }) as unknown as Call);
  assert.equal(membershipOf("reg")?.status, "failed");
});

test("a refused save puts the flip back; an accepted one keeps it", async () => {
  await loadMembership("reg", reply(200, { watchedIds: ["a"], teamWatchedIds: [], teamAvailable: true }));
  assert.equal(await setWatch("reg", "b", "personal", true, reply(403)), false);
  assert.deepEqual(membershipOf("reg")?.watched, ["a"], "the refused watch was reverted");
  assert.equal(await setWatch("reg", "a", "personal", false, reply(403)), false);
  assert.deepEqual(membershipOf("reg")?.watched, ["a"], "the refused unwatch was reverted");
  assert.equal(await setWatch("reg", "b", "personal", true, reply(200)), true);
  assert.deepEqual(membershipOf("reg")?.watched, ["a", "b"]);
  assert.equal(await setWatch("reg", "b", "personal", false, (async () => { throw new Error("offline"); }) as unknown as Call), false);
  assert.deepEqual(membershipOf("reg")?.watched, ["a", "b"], "a network failure reverts as well");
});
