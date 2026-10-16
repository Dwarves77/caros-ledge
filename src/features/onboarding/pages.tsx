// Ported from old_repo/src/app/onboarding/page.tsx (lines 16-34)
// Ported from old_repo/src/app/workspace/new/page.tsx (lines 15-30)
// Ported from old_repo/src/app/invitations/[token]/page.tsx (lines 13-27)
import { redirect, unstable_rethrow } from "next/navigation";

import { getClaims } from "@/core/auth/claims";
import { userClient } from "@/core/db/clients";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/features/account/ui/PageFailure";
import { readAggregates } from "@/features/lists";

import { InvitationLandingPage } from "./ui/InvitationLandingPage";
import { NoWorkspaceLanding } from "./ui/NoWorkspaceLanding";
import { OnboardingWizard } from "./ui/OnboardingWizard";

/** /onboarding: steps 2 to 4. A reader with no workspace goes to /workspace/new first. The step-2 preview shows the workspace's real band counts, or says they did not load. */
export async function OnboardingRoute() {
  const session = await pageSession("/onboarding");
  if ("failed" in session) return <PageFailure what="Onboarding" />;
  if (!session.orgId) redirect("/workspace/new");
  const aggregates = await readAggregates(await userClient(), session.orgId);
  return <OnboardingWizard userId={session.userId} orgId={session.orgId} byPriority={aggregates?.byPriority ?? null} />;
}

/** /workspace/new: step 1. A reader who already has a workspace goes to the dashboard. */
export async function NewWorkspaceRoute() {
  const session = await pageSession("/workspace/new");
  if ("failed" in session) return <PageFailure what="Setup" />;
  if (session.orgId) redirect("/");
  return <NoWorkspaceLanding userId={session.userId} userEmail={session.email} />;
}

/** /invitations/[token]: no session sends the visitor to /login and back; a failed claims check is a failure page, never "signed out". */
export async function InvitationRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let claims;
  try {
    claims = await getClaims(await userClient());
  } catch (e) {
    unstable_rethrow(e);
    return <PageFailure what="The invitation" />;
  }
  if (!claims) redirect(`/login?redirect=${encodeURIComponent(`/invitations/${token}`)}`);
  return <InvitationLandingPage token={token} userEmail={claims.email ?? ""} />;
}
