// Wiring 2 and the failed-action defects: a member action whose request is refused puts the change back and SAYS so, in the server's own sentence (the old star, mute and moderation actions failed silently because the
// toast callback was never passed). Each action is driven here with a failing client and a recording notify.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Result } from "@/features/community/lib/api";
import { actOnReport, citeItem, setGroupPref, setMembership } from "@/features/community/lib/actions";

const ok = <T>(data: T): Result<T> => ({ ok: true, status: 200, data, error: null });
const refused = (error: string | null = "You can't change this setting"): Result<never> => ({ ok: false, status: 403, data: null, error: error as string });
const recorder = () => {
  const said: Array<[string, string | undefined]> = [];
  return { said, notify: (m: string, v?: "success" | "error") => void said.push([m, v]) };
};

test("a star or mute that is refused is put back and said, in the server's sentence; one that succeeds is confirmed", async () => {
  for (const kind of ["starred", "muted"] as const) {
    const applied: boolean[] = [];
    const { said, notify } = recorder();
    const api = { setStarred: async () => refused("Not a member"), setMuted: async () => refused("Not a member") };
    assert.equal(await setGroupPref(api, notify, kind, "g", true, (v) => applied.push(v)), false);
    assert.deepEqual(applied, [true, false], `${kind}: shown at once, then put back`);
    assert.deepEqual(said, [["Not a member", "error"]]);
    const good = recorder();
    const seen: boolean[] = [];
    assert.equal(await setGroupPref({ setStarred: async () => ok({ ok: true as const }), setMuted: async () => ok({ ok: true as const }) }, good.notify, kind, "g", true, (v) => seen.push(v)), true);
    assert.deepEqual(seen, [true]);
    assert.notEqual(good.said[0]?.[1], "error", "a confirmation is not an error");
  }
  const mute = recorder();
  await setGroupPref({ setStarred: async () => refused(), setMuted: async () => ok({ ok: true as const }) }, mute.notify, "muted", "g", true, () => {});
  assert.match(String(mute.said[0]?.[0]), /not be notified/, "a mute says what it does");
  const empty = recorder();
  await setGroupPref({ setStarred: async () => refused(null), setMuted: async () => refused(null) }, empty.notify, "muted", "g", true, () => {});
  assert.equal(empty.said[0]?.[0], "The mute could not be changed.", "a refusal with no sentence still says something");
});

test("a moderation action that is refused is said and does not close the report; one that closes tells when the member could not be notified", async () => {
  const bad = recorder();
  let done = 0;
  assert.equal(await actOnReport({ act: async () => refused("Moderator or platform admin access required") }, bad.notify, "r", "ban", " note ", () => done++), false);
  assert.deepEqual([done, bad.said], [0, [["Moderator or platform admin access required", "error"]]]);
  const good = recorder();
  assert.equal(await actOnReport({ act: async () => ok({ ok: true as const, status: "resolved", action: "ban", notified: true }) }, good.notify, "r", "ban", "", () => done++), true);
  assert.deepEqual([done, good.said], [1, [["Member banned from the group", "success"]]]);
  const mute = recorder();
  await actOnReport({ act: async () => ok({ ok: true as const, status: "resolved", action: "warn", notified: false }) }, mute.notify, "r", "warn", "", () => done++);
  assert.deepEqual(mute.said, [["Warning sent. The member could not be notified.", "error"]], "an action taken whose notice failed is both: done, and said");
  assert.equal(done, 2);
});

test("joining, leaving and citing go through the routes and say a refusal (they were table writes from the browser)", async () => {
  const { said, notify } = recorder();
  assert.equal(await setMembership({ joinGroup: async () => refused("This group is by invitation only"), leaveGroup: async () => ok({ ok: true as const }) }, notify, "g", true), false);
  assert.equal(await setMembership({ joinGroup: async () => ok({ ok: true as const, state: "joined" as const }), leaveGroup: async () => refused(null) }, notify, "g", false), false);
  assert.deepEqual(said, [["This group is by invitation only", "error"], ["You could not leave this group.", "error"]]);
  const cite = recorder();
  assert.equal(await citeItem({ cite: async () => refused("That item is not available to cite") }, cite.notify, "p", "i"), null);
  assert.equal(await citeItem({ cite: async () => ok({ ok: true as const, cited: ["i"] }) }, cite.notify, "p", null), null, "an item with no id cannot be cited, and says so");
  assert.deepEqual(await citeItem({ cite: async () => ok({ ok: true as const, cited: ["i"] }) }, cite.notify, "p", "i"), ["i"]);
  assert.deepEqual(cite.said.map((s) => s[0]), ["That item is not available to cite", "That item can't be cited yet."]);

});
