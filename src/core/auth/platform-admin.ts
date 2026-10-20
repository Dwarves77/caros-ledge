// Ported from old_repo/src/lib/auth/platform-admin-gate.ts (lines 1-54)
// Ported from old_repo/src/lib/auth/admin.ts (lines 27-82)
import { redirect } from "next/navigation";

import { userClient, type Db } from "@/core/db/clients";

import { getClaims, type ClaimsClient } from "./claims";
import { LookupError } from "./membership";

/** The caller's own platform-admin bit through the rpc (migration 375: the column itself is not selectable). Only a literal true admits. */
export async function readOwnPlatformAdmin(client: Pick<Db, "rpc">): Promise<boolean> {
  const { data, error } = await client.rpc("is_platform_admin");
  if (error) throw new LookupError("is_platform_admin", error);
  return data === true;
}

export type PlatformAdminDecision = { kind: "anonymous" } | { kind: "denied"; userId: string } | { kind: "admitted"; userId: string; email: string };

/** The page gate's decision, separate from the redirect so it can be tested. A flag read error denies. */
async function decidePlatformAdmin(client: ClaimsClient & Pick<Db, "rpc">): Promise<PlatformAdminDecision> {
  const claims = await getClaims(client);
  if (!claims) return { kind: "anonymous" };
  try {
    return (await readOwnPlatformAdmin(client)) ? { kind: "admitted", userId: claims.userId, email: claims.email ?? "" } : { kind: "denied", userId: claims.userId };
  } catch {
    return { kind: "denied", userId: claims.userId };
  }
}

/** Server-component gate: no session goes to /login, a non-admin to /, an admin gets `{ userId, email }`. */
export async function requirePlatformAdmin(redirectPath = "/admin"): Promise<{ userId: string; email: string }> {
  const decision = await decidePlatformAdmin(await userClient());
  if (decision.kind === "anonymous") redirect(`/login?redirect=${encodeURIComponent(redirectPath)}`);
  if (decision.kind === "denied") redirect("/");
  return { userId: decision.userId, email: decision.email };
}
