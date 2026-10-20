// Ported from old_repo/src/components/shell/bootstrap-seed.ts (lines 76-129)
// Ported from old_repo/src/components/app-shell-banner.ts (lines 1-46)
// What the shell does with the identity states. The seed type, the error seed, the apply guard, the admin-nav gate and the retry schedule are P2-01's
// identity-loader (re-exported here, not copied); this file adds the workspace label and the banner and redirect table.
import type { IdentityStatus } from "@/features/auth/ui/identity-loader";

import { suppressesWorkspaceNote } from "./nav-model";

export { IDENTITY_ERROR_SEED, nextIdentityRetryDelay, resolveAuthSeed, shouldApplySeed, shouldShowAdminNav } from "@/features/auth/ui/identity-loader";
export type { AuthSeed, IdentityStatus } from "@/features/auth/ui/identity-loader";

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
