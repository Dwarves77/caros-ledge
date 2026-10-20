// R2e M3: a headshot is drawn only from the app's own storage origin. An address an author chose on any other host would make every viewer's browser contact that host.
import assert from "node:assert/strict";
import { test } from "node:test";

import { avatarSrc } from "@/features/community/lib/avatar-src";

const STORE = "https://abc.supabase.co";

test("avatarSrc: https on the storage origin under /storage/v1/ is drawn; every other address is not", () => {
  const good = `${STORE}/storage/v1/object/public/avatars/u.png`;
  assert.equal(avatarSrc(good, STORE), good);
  for (const bad of ["https://evil.example/pixel.png", `http://abc.supabase.co/storage/v1/object/public/a.png`, `${STORE}/auth/v1/user`, `${STORE}.evil.example/storage/v1/x`, "https://abc.supabase.co@evil.example/storage/v1/x", "javascript:alert(1)", "data:image/png;base64,AAAA", "not a url", ""]) assert.equal(avatarSrc(bad, STORE), null, bad);
  assert.equal(avatarSrc(good, undefined), null, "no storage origin configured: nothing is drawn");
  assert.equal(avatarSrc(null, STORE), null);
});
