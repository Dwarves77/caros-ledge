// Ported from old_repo/src/components/shell/bootstrap-seed.ts (lines 76-129)
// Ported from old_repo/src/components/app-shell-banner.ts (lines 1-46)
// What the shell does with the identity states. The seed type, the error seed, the apply guard, the admin-nav gate and the retry schedule live here
// alongside the workspace label and the banner and redirect table.
import { retryDelayMs } from "@/core/http/backoff";
import type { IdentityBootstrap, OrgRole } from "@/core/types";

import { suppressesWorkspaceNote } from "./nav-model";

export type IdentityStatus = "pending" | "resolved" | "error";

export interface AuthSeed {
  status: Exclude<IdentityStatus, "pending">;
  user: IdentityBootstrap["user"];
  orgId: string | null | undefined;
  orgName: string;
  role: OrgRole | null;
  sectors: string[];
  isPlatformAdmin: boolean;
}

export const IDENTITY_ERROR_SEED: AuthSeed = Object.freeze({ status: "error", user: null, orgId: undefined, orgName: "", role: null, sectors: [], isPlatformAdmin: false });

export function resolveAuthSeed(bootstrap: IdentityBootstrap | null): AuthSeed {
  if (!bootstrap) return IDENTITY_ERROR_SEED;
  return {
    status: "resolved",
    user: bootstrap.user,
    orgId: bootstrap.user ? bootstrap.orgId : undefined,
    orgName: bootstrap.orgName,
    role: bootstrap.role,
    sectors: bootstrap.sectors.length > 0 ? bootstrap.sectors : bootstrap.workspaceSectors,
    isPlatformAdmin: !!bootstrap.user && bootstrap.isPlatformAdmin === true,
  };
}

export const shouldApplySeed = (current: IdentityStatus): boolean => current !== "resolved";
export const shouldShowAdminNav = (p: { status: IdentityStatus; isPlatformAdmin: boolean }): boolean => p.status === "resolved" && p.isPlatformAdmin === true;
export const nextIdentityRetryDelay = retryDelayMs;

const NO_WORKSPACE_ONBOARDING_ROUTE = "/workspace/new";

/** The account row's workspace label: "No workspace" only on a RESOLVED null; a pending lookup says loading and a failed one says unavailable (never "none"). */
export function workspaceLabel(status: IdentityStatus, orgName: string): string {
  if (status === "error") return "Workspace unavailable";
  if (status === "pending") return "Loading workspace";
  return orgName || "No workspace";
}

interface ShellNoteInput {
  user: unknown;
  /** undefined while unresolved, null once known to have no workspace, else the active org. */
  orgId: string | null | undefined;
  identityStatus: IdentityStatus;
  pathname: string;
}
export interface ShellNotes {
  /** A resolved user with no workspace: sent to onboarding, with the banner as the fallback. */
  noWorkspace: boolean;
  redirect: string | null;
  /** A failed identity lookup: an error note with Retry, never "no workspace". */
  identityError: boolean;
}

/** The banner and redirect table across pending, resolved, error and signed-out, on chrome and chromeless routes. */
export function shellNotes({ user, orgId, identityStatus, pathname }: ShellNoteInput): ShellNotes {
  const suppressed = suppressesWorkspaceNote(pathname);
  const noWorkspace = identityStatus === "resolved" && !!user && orgId === null && !suppressed;
  return { noWorkspace, redirect: noWorkspace ? NO_WORKSPACE_ONBOARDING_ROUTE : null, identityError: identityStatus === "error" && !!user && !suppressed };
}
