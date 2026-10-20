// Ported from old_repo/src/lib/community/organisation-key.mjs (lines 25-95)
// Ported from old_repo/src/lib/community/organisation-salt.ts (lines 1-20)
// The member's pseudonymous organisation key (INV-235) is an HMAC-SHA256 of the domain they proved they control (lib/domain-proof.ts) under a server-only salt, never returned to any client. The free-mail list below is NOT
// a verification (a name on a list proves nothing): it only keeps a key from naming a mail provider as if it were an organisation. COMMUNITY_ORG_SALT is the salt; where it is not set the salt is derived from WORKER_SECRET.
// Rotating WORKER_SECRET without COMMUNITY_ORG_SALT changes every key derived afterwards (keys derived before and after stop matching), so a deployment sets COMMUNITY_ORG_SALT once and never rotates it.
import { createHmac, hkdfSync } from "node:crypto";

import { z } from "zod";

import freeMail from "./data/free-mail.json";

const FREE_MAIL: ReadonlySet<string> = new Set(z.array(z.string().min(3)).min(1).parse(freeMail));
const ORG_SALT_HKDF_INFO = "caros-ledge/community-organisation-key/v1";
const normalise = (domain: unknown): string => String(domain ?? "").trim().toLowerCase().replace(/^@/, "");

export const isFreeMailDomain = (domain: unknown): boolean => FREE_MAIL.has(normalise(domain));

/** The domain half of an address (lower-cased); null unless it is `local@domain` with a dot in the domain. */
export function domainFromEmail(email: string | null | undefined): string | null {
  const t = String(email ?? "").trim().toLowerCase();
  const at = t.lastIndexOf("@");
  if (at <= 0 || at === t.length - 1) return null;
  const domain = t.slice(at + 1);
  return domain.includes(".") ? domain : null;
}

/** The salt and where it came from; null when neither source is long enough (16 characters). */
export function resolveOrganisationSalt(env: Record<string, string | undefined> = process.env): { salt: string | null; source: "COMMUNITY_ORG_SALT" | "derived-from-WORKER_SECRET" | null } {
  const explicit = (env.COMMUNITY_ORG_SALT ?? "").trim();
  if (explicit.length >= 16) return { salt: explicit, source: "COMMUNITY_ORG_SALT" };
  const worker = (env.WORKER_SECRET ?? "").trim();
  if (worker.length >= 16) return { salt: Buffer.from(hkdfSync("sha256", worker, "", ORG_SALT_HKDF_INFO, 32)).toString("hex"), source: "derived-from-WORKER_SECRET" };
  return { salt: null, source: null };
}

/** Pure: the key, or the reason it was refused. */
export function deriveOrganisationKey(a: { domain?: string | null; verified?: boolean; salt?: string | null }): { organisationKey: string | null; reason: string | null } {
  if (a.verified !== true) return { organisationKey: null, reason: "member is not verified" };
  const d = normalise(a.domain);
  if (!d || !d.includes(".")) return { organisationKey: null, reason: "no valid email domain to derive from" };
  if (isFreeMailDomain(d)) return { organisationKey: null, reason: `"${d}" is a free-mail domain, not a corporate identity` };
  if (!a.salt || !a.salt.trim()) return { organisationKey: null, reason: "the organisation salt is not configured" };
  return { organisationKey: createHmac("sha256", a.salt).update(d, "utf8").digest("hex"), reason: null };
}
