// Ported from old_repo/src/lib/auth/classify-signup-result.mjs (lines 6-13)

/** What a signUp call means: Supabase answers an already-registered address with no error and an empty identities list. */
export function classifySignUpResult(result: { data?: { user?: { identities?: unknown } | null } | null; error?: unknown } | null | undefined): "error" | "already_registered" | "confirmation_sent" {
  if (result?.error) return "error";
  const identities = result?.data?.user?.identities;
  return Array.isArray(identities) && identities.length === 0 ? "already_registered" : "confirmation_sent";
}
