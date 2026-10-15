// Ported from old_repo/src/app/invitations/[token]/page.tsx (lines 13-27)
import { redirect } from "next/navigation";

import { getClaims } from "@/core/auth/claims";
import { userClient } from "@/core/db/clients";

import { InvitationLanding } from "./InvitationLanding";

/** Server gate for the invitation landing: no session sends the visitor to /login and back; a failed claims check surfaces as an error, never as "signed out". */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const claims = await getClaims(await userClient());
  if (!claims) redirect(`/login?redirect=${encodeURIComponent(`/invitations/${token}`)}`);
  return <InvitationLanding token={token} userEmail={claims.email ?? ""} />;
}
