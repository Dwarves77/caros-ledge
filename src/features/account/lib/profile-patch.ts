// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 94-96)
// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 230-245)
// Ported from old_repo/src/components/onboarding/NoWorkspaceLanding.tsx (lines 94-109)
import { z } from "zod";

import { readFailure } from "@/core/http/failure";
import type { Db } from "@/core/db/clients";

/**
 * What the browser may write to its own profiles row (INV-137). verifier_status and verifier_since are system-written (migration 367; a
 * request goes through the request_verification rpc) and every privilege column is column-grant protected: the schema is STRICT, so a
 * patch that names any other column is refused here before a request is made, not only by the database and the type.
 */
const profilePatchSchema = z
  .object({
    full_name: z.string().max(200).nullable(),
    bio: z.string().max(4000).nullable(),
    job_title: z.string().max(120).nullable(),
    avatar_url: z.string().max(2000).nullable(),
    jurisdiction_overrides: z.array(z.string()),
    transport_mode_overrides: z.array(z.string()),
  })
  .partial()
  .strict();
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/** Write the caller's own profile row. Resolves to an error message, or null when it landed. */
export async function saveProfilePatch(client: Db, userId: string, patch: unknown): Promise<string | null> {
  const parsed = profilePatchSchema.safeParse(patch);
  if (!parsed.success) return `Invalid profile change: ${parsed.error.issues[0]?.message ?? "invalid"}`;
  const { error } = await client.from("profiles").update({ ...parsed.data, updated_at: new Date().toISOString() }).eq("id", userId);
  return error ? readFailure(error) : null;
}
