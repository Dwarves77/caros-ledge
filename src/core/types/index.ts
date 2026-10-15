// Ported from old_repo/src/lib/api/org.ts (lines 40-45)
// Ported from old_repo/src/lib/api/server-bootstrap.ts (lines 48-76)
export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface OrgMembership {
  orgId: string;
  role: OrgRole;
}

/** The one identity payload: `/api/auth/identity` answers it and the client seeds from it. */
export interface IdentityBootstrap {
  user: { id: string; email: string | null } | null;
  orgId: string | null;
  orgName: string;
  role: OrgRole | null;
  sectors: string[];
  workspaceSectors: string[];
  isPlatformAdmin: boolean;
}
