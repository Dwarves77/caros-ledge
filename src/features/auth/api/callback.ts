// Ported from old_repo/src/app/auth/callback/route.ts (lines 21-60)
import { ensureProfile } from "@/core/auth/ensure-profile";
import { sanitizeReturnPath } from "@/core/auth/route-policy";
import { userClient } from "@/core/db/clients";
import { checkRateLimit, clientKey } from "@/core/http/rate-limit";

/** The auth redirect target: exchange the code, create the profile row and nothing else (a user with no membership goes to onboarding), then a same-origin return. */
export async function GET(request: Request) {
  const limited = await checkRateLimit(clientKey(request));
  if (limited) return limited;
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = sanitizeReturnPath(searchParams.get("next"));
  if (code) {
    const { data, error } = await (await userClient(request)).auth.exchangeCodeForSession(code);
    if (!error) {
      if (data?.user?.id) await ensureProfile(data.user.id, data.user.email ?? null);
      return Response.redirect(`${origin}${next}`, 307);
    }
  }
  return Response.redirect(`${origin}/login?error=auth_failed`, 307);
}
