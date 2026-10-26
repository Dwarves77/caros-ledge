// TITLE-1 part A: the masthead names the reader from profiles.display_name, else the first token of profiles.full_name, else a neutral copy token. An e-mail address is never a name, and a name is never case-transformed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveBriefTitle, firstNameOf } from "@/features/dashboard/rows";

import { USER } from "../workspace/_world.ts";
import { renderApp } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

const h1Of = async (profile: { display_name: string | null; full_name: string | null }, metadata?: Record<string, unknown>): Promise<string> => {
  const w = memberWorld(metadata);
  Object.assign(w.db.rows("profiles").find((p) => p.id === USER.member)!, profile);
  const html = renderApp(((await (await import("@/features/dashboard/page")).default()) as never), { path: "/" });
  return /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)![1]!.replace(/&#x27;|&#39;/g, "'");
};

test("display_name is drawn as stored", async () => {
  assert.equal(await h1Of({ display_name: "Pat", full_name: "Pat Lee" }), "Pat's Brief");
  assert.equal(await h1Of({ display_name: "O'Brien", full_name: null }), "O'Brien's Brief");
});

test("full_name only: the first token, not the whole name", async () => {
  assert.equal(await h1Of({ display_name: null, full_name: "Ada Lovelace" }), "Ada's Brief");
});

test("neither name: the copy token, and the session's e-mail handle appears nowhere in the masthead (attack: member@example.test is in the session)", async () => {
  const h1 = await h1Of({ display_name: null, full_name: null });
  assert.equal(h1, "Your Brief");
  assert.doesNotMatch(h1, /member/i);
});

test("a name is never case-transformed; a name with a replacement pattern is drawn literally", () => {
  assert.equal(deriveBriefTitle("McDonald"), "McDonald's Brief");
  assert.equal(deriveBriefTitle("patlee"), "patlee's Brief");
  assert.equal(deriveBriefTitle("$&"), "$&'s Brief");
  assert.equal(deriveBriefTitle(null), "Your Brief");
  assert.equal(firstNameOf({ display_name: "  ", full_name: "  Ada  Lovelace " }), "Ada");
  assert.equal(firstNameOf(null), null);
});

// ROWS-1: the operator's profile holds no name, so the masthead said "Your Brief". The cause is the profile heal: it fills profiles.full_name from the sign-in provider's user_metadata when the name is empty.
test("a profile with no name takes the provider's name: the masthead says the first name and the row holds the full one", async () => {
  assert.equal(await h1Of({ display_name: null, full_name: null }, { full_name: "Jason Losh", name: "J. L." }), "Jason's Brief");
  assert.equal(await h1Of({ display_name: null, full_name: null }, { name: "Ada Lovelace" }), "Ada's Brief", "name when full_name is absent");
  const w = memberWorld({ full_name: "Jason Losh" });
  Object.assign(w.db.rows("profiles").find((p) => p.id === USER.member)!, { display_name: null, full_name: null });
  renderApp(((await (await import("@/features/dashboard/page")).default()) as never), { path: "/" });
  assert.equal(w.db.rows("profiles").find((p) => p.id === USER.member)!.full_name, "Jason Losh", "the heal wrote the name");
});

test("no provider name: 'Your Brief'; a provider name that is an e-mail address is no name; a stored name is never overwritten; the e-mail appears nowhere", async () => {
  assert.equal(await h1Of({ display_name: null, full_name: null }, {}), "Your Brief");
  const mail = await h1Of({ display_name: null, full_name: null }, { full_name: "member@example.test" });
  assert.equal(mail, "Your Brief");
  assert.doesNotMatch(mail, /member|@/i);
  assert.equal(await h1Of({ display_name: null, full_name: "Pat Lee" }, { full_name: "Jason Losh" }), "Pat's Brief");
});
