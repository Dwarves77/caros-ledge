// Ported from old_repo/src/lib/api/server-bootstrap.ts (lines 48-228)
import type { Db } from "@/core/db/clients";
import type { IdentityBootstrap, OrgRole } from "@/core/types";

import { getClaims, type ClaimsClient } from "./claims";
import { ensureProfile } from "./ensure-profile";
import { LookupError } from "./membership";
import { readOwnPlatformAdmin } from "./platform-admin";

export const EMPTY_IDENTITY: IdentityBootstrap = { user: null, orgId: null, orgName: "", role: null, sectors: [], workspaceSectors: [], isPlatformAdmin: false };

type OrgEmbed = { id?: string; name?: string; workspace_settings?: { sector_profile: string[] | null }[] | null } | null;

/**
 * One server pass for who the caller is: claims, the oldest membership with its organisation and sectors, sector overrides, the admin bit.
 * No session resolves to the empty identity. Any failed lookup throws LookupError, which the route answers 503 and the client retries:
 * a failed lookup is never rendered as "no workspace" (lane AUTH-IDENTITY). A missing profile row is healed (INV-154).
 */
export async function resolveIdentity(client: Db & ClaimsClient, opts: { heal?: boolean } = {}): Promise<IdentityBootstrap> {
  const claims = await getClaims(client);
  if (!claims) return EMPTY_IDENTITY;
  const [membership, profile, admin] = await Promise.all([
    client.from("org_memberships").select("org_id, role, organizations(id, name, workspace_settings(sector_profile))").eq("user_id", claims.userId).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    client.from("profiles").select("sector_overrides").eq("id", claims.userId).maybeSingle(),
    readOwnPlatformAdmin(client),
  ]);
  if (membership.error) throw new LookupError("org_memberships", membership.error);
  if (profile.error) throw new LookupError("profiles", profile.error);
  let overrides = (profile.data as { sector_overrides: string[] | null } | null)?.sector_overrides ?? null;
  if (!profile.data && opts.heal !== false) {
    // The heal runs on the caller's own client: profiles_self_insert admits exactly the row id = auth.uid(), so no service key is needed. A heal that fails is a stated 503, never a silent empty profile.
    const healed = await ensureProfile(claims.userId, claims.email, client);
    if (!healed.exists) throw new LookupError("profile heal", healed.reason ?? healed.failedStep ?? "unavailable");
    overrides = [];
  }
  const org = (membership.data?.organizations ?? null) as OrgEmbed;
  return {
    user: { id: claims.userId, email: claims.email },
    orgId: org?.id || (membership.data?.org_id as string | undefined) || null,
    orgName: org?.name || "",
    role: (membership.data?.role as OrgRole | undefined) ?? null,
    sectors: overrides ?? [],
    workspaceSectors: org?.workspace_settings?.[0]?.sector_profile ?? [],
    isPlatformAdmin: admin,
  };
}
