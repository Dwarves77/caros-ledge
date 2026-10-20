// Ported from old_repo/src/app/api/community/profile/route.ts (lines 1-67)
// Ported from old_repo/src/app/api/community/profile/verify/route.ts (lines 12-99)
// The member's own Community profile: GET it, PUT the declared fields (an allowlist; the verification columns are never writable by a member), and verify (INV-235): the member publishes a DNS TXT record on the domain of their
// account address, the route reads it, and a match is recorded with the organisation key by record_domain_verification (service_role only, one transaction with its event). The key is never returned. An administrator's mark is the
// other recorded kind (admin_mark_verified); LinkedIn is not built.
import { serviceClient } from "@/core/db/clients";
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { checkDomainProof, proofRecord } from "../lib/domain-proof";
import { domainFromEmail, deriveOrganisationKey, resolveOrganisationSalt } from "../lib/org-key";
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

/** What the member publishes to prove they control the domain of their account address: the record's host and value. Derived, never stored. */
export const GET_VERIFY = route("/api/community/profile/verify", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const domain = domainFromEmail(auth.email);
  if (!domain) throw new HttpError(400, "Your account has no email address to verify against");
  const { salt } = resolveOrganisationSalt();
  if (!salt) throw new HttpError(503, "Verification is not available right now", { "Retry-After": "60" });
  return ok(auth.headers, { domain, ...proofRecord(auth.userId, domain, salt) });
});

/**
 * Verification is a check the system PERFORMS and RECORDS (migration 0103): it reads the DNS TXT record the member published at the proof host of their account address's domain, and only a match is recorded
 * (record_domain_verification, with its admin_events row, in one transaction). A domain that is not theirs cannot pass, whatever its name, and a lookup that failed is a retry, never a refusal of the member.
 */
export const POST_VERIFY = route("/api/community/profile/verify", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const domain = domainFromEmail(auth.email);
  if (!domain) throw new HttpError(400, "Your account has no email address to verify against");
  const { salt } = resolveOrganisationSalt();
  if (!salt) throw new HttpError(503, "Verification is not available right now", { "Retry-After": "60" });
  const proof = await checkDomainProof(auth.userId, domain, salt, () => new Date());
  if (!proof.ok && proof.reason === "lookup_failed") throw new HttpError(503, "Your domain's records could not be read just now. Try again in a minute.", { "Retry-After": "60" });
  if (!proof.ok) throw new HttpError(409, `The record was not found at ${proofRecord(auth.userId, domain, salt).host}. Publish it, allow a few minutes for DNS to update, and check again.`);
  const { organisationKey, reason } = deriveOrganisationKey({ domain, verified: true, salt });
  if (!organisationKey) throw new HttpError(403, `This domain cannot be recorded as an organisation (${reason ?? "no key"}).`);
  const { error } = await serviceClient().rpc("record_domain_verification", { p_user_id: auth.userId, p_domain: domain, p_organisation_key: organisationKey, p_evidence: proof.evidence });
  if (error) throw dbError(error);
  const row = await one<Record<string, unknown>>(auth.client.from("community_member_profiles").select(COLUMNS).eq("user_id", auth.userId).maybeSingle(), "profile");
  return ok(auth.headers, { profile: projectOwnProfile(row) });
});
