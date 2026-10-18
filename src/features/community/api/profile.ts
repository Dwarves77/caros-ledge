// Ported from old_repo/src/app/api/community/profile/route.ts (lines 1-67)
// Ported from old_repo/src/app/api/community/profile/verify/route.ts (lines 12-99)
// The member's own Community profile: GET it, PUT the declared fields (an allowlist; the verification columns are never writable by a member), and POST verify (INV-235): a confirmed account address on a non-free-mail
// domain is the verification, written with the organisation key by the service client in one write of the four columns. The key is never returned. LinkedIn is a second verification method the column admits; it is not built.
import { serviceClient } from "@/core/db/clients";
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { domainFromEmail, deriveOrganisationKey, isCorporateDomain, resolveOrganisationSalt } from "../lib/org-key";
import { projectOwnProfile, sanitizeMemberWrite } from "../lib/profile-policy";

import { one } from "./_http";

const COLUMNS = "org_type, role, sector, region, verified, verified_at, verification_method, default_anonymous";

export const GET = route("/api/community/profile", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const row = await one<Record<string, unknown>>(auth.client.from("community_member_profiles").select(COLUMNS).eq("user_id", auth.userId).maybeSingle(), "profile");
  return ok(auth.headers, { profile: projectOwnProfile(row) });
});

export const PUT = route("/api/community/profile", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const sanitized = sanitizeMemberWrite(body);
  if (!sanitized.ok) throw new HttpError(400, sanitized.error);
  const { data, error } = await auth.client.from("community_member_profiles").upsert({ user_id: auth.userId, ...sanitized.data }, { onConflict: "user_id" }).select(COLUMNS).maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't change this profile" });
  return ok(auth.headers, { profile: projectOwnProfile(data) });
});

export const POST_VERIFY = route("/api/community/profile/verify", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const domain = domainFromEmail(auth.email);
  if (!domain) throw new HttpError(400, "Your account has no email address to verify against");
  if (!isCorporateDomain(domain)) throw new HttpError(403, `${domain} is a personal mail domain, not a company one. Verify with a company email address on your account.`);
  const { salt } = resolveOrganisationSalt();
  const { organisationKey, reason } = deriveOrganisationKey({ domain, verified: true, salt });
  if (!organisationKey) throw new HttpError(503, `Verification is not available right now (${reason ?? "no key"})`, { "Retry-After": "60" });
  const service = serviceClient();
  const verifiedAt = new Date().toISOString();
  const fields = { verified: true, verified_at: verifiedAt, verification_method: "corporate-email", organisation_key: organisationKey };
  const existing = await one<{ user_id: string }>(service.from("community_member_profiles").select("user_id").eq("user_id", auth.userId).maybeSingle(), "profile");
  const write = existing ? service.from("community_member_profiles").update(fields).eq("user_id", auth.userId) : service.from("community_member_profiles").insert({ user_id: auth.userId, org_type: "other", ...fields });
  const { data, error } = await write.select(COLUMNS).maybeSingle();
  if (error) throw dbError(error);
  return ok(auth.headers, { profile: projectOwnProfile(data) });
});
