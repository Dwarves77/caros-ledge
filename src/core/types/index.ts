// Ported from old_repo/src/lib/api/org.ts (lines 40-45)
// Ported from old_repo/src/lib/api/server-bootstrap.ts (lines 48-76)
// Ported from old_repo/src/types/resource.ts (lines 1-311)
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

export type { BiasTag, ChangeLogEntry, Dispute, ImpactReasoning, ImpactScores, ItemConnection, OperationalImpact, RecommendedAction, Resource, RiskRegisterEntry, SourceReference, Supersession, TimelineEntry } from "./item";
export { runResult, worst } from "./run-result";
export type { RunOutcome, RunResult } from "./run-result";
