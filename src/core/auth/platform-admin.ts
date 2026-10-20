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

/** Another user's flag, read on the service client. A failed read throws LookupError; it is never read as "not an admin". */
export async function isPlatformAdmin(userId: string, service: Db): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await service.from("profiles").select("is_platform_admin").eq("id", userId).maybeSingle();
  if (error) throw new LookupError("profiles.is_platform_admin", error);
  return data?.is_platform_admin === true;
}

export type PlatformAdminDecision = { kind: "anonymous" } | { kind: "denied"; userId: string } | { kind: "admitted"; userId: string; email: string };

/** The page gate's decision, separate from the redirect so it can be tested. A failed flag read throws LookupError to the page's failure state: it is never "not an admin" (C:24, W:20). */
export async function decidePlatformAdmin(client: ClaimsClient & Pick<Db, "rpc">): Promise<PlatformAdminDecision> {
  const claims = await getClaims(client);
  if (!claims) return { kind: "anonymous" };
  return (await readOwnPlatformAdmin(client)) ? { kind: "admitted", userId: claims.userId, email: claims.email ?? "" } : { kind: "denied", userId: claims.userId };
}

/** Server-component gate: no session goes to /login, a non-admin to /, an admin gets `{ userId, email }`. */
export async function requirePlatformAdmin(redirectPath = "/admin"): Promise<{ userId: string; email: string }> {
  const decision = await decidePlatformAdmin(await userClient());
  if (decision.kind === "anonymous") redirect(`/login?redirect=${encodeURIComponent(redirectPath)}`);
  if (decision.kind === "denied") redirect("/");
  return { userId: decision.userId, email: decision.email };
}
