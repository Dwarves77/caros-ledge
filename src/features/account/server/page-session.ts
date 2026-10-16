// Ported from old_repo/src/app/profile/page.tsx (lines 16-25)
// Ported from old_repo/src/app/onboarding/page.tsx (lines 16-34)
// Ported from old_repo/src/app/workspace/new/page.tsx (lines 15-30)
import { redirect, unstable_rethrow } from "next/navigation";

import { resolveIdentity } from "@/core/auth/identity";
import { userClient } from "@/core/db/clients";
import { log } from "@/core/shared/log";
import type { OrgRole } from "@/core/types";

export interface PageSession {
  userId: string;
  email: string;
  orgId: string | null;
  orgName: string;
  role: OrgRole | null;
  /** The one server instant for this request: no render reads a clock. */
  nowIso: string;
}

/**
 * The server gate every account, settings and onboarding page shares: who is asking, and the request's one instant. A visitor without a session goes to
 * /login and back; a failed identity lookup is `{ failed: true }` for the page to say so with Retry, never "signed out" and never "no workspace".
 */
export async function pageSession(returnTo: string): Promise<PageSession | { failed: true }> {
  let identity;
  try {
    identity = await resolveIdentity(await userClient());
  } catch (e) {
    unstable_rethrow(e); // a redirect or the dynamic-rendering signal is Next's, not a failed lookup
    log.warn("[page-session] the identity lookup failed:", e instanceof Error ? e.message : String(e));
    return { failed: true };
  }
  if (!identity.user) redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
  return { userId: identity.user.id, email: identity.user.email ?? "", orgId: identity.orgId, orgName: identity.orgName, role: identity.role, nowIso: new Date().toISOString() };
}
