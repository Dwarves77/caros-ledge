// Ported from old_repo/src/lib/community/profile-policy.mjs (lines 1-109)
// What a member may write to their own community profile, and how the row is shown back. The region list is the core workspace vocabulary's (IMP-069: one list). The verification columns are never in the
// allowlist: they are written only by the server verification path (INV-135, INV-235), and the database guard is the second wall.
import { ORG_TYPES, REGION_CODES } from "./labels";
import type { OwnProfile } from "./types";

const MAX_ROLE_LEN = 120;
const MAX_SECTOR_LEN = 80;

export interface ProfileWrite {
  org_type: string;
  role: string | null;
  sector: string | null;
  region: string | null;
  default_anonymous: boolean;
}
export type ProfileWriteResult = { ok: true; data: ProfileWrite } | { ok: false; error: string };

const trimmedOrNull = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The allowlist: org type (required), role, sector, region, default anonymity. Anything else in the body is dropped; a bad value is a refusal with the reason, never a silent coercion. */
export function sanitizeMemberWrite(body: unknown): ProfileWriteResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "request body must be a JSON object" };
  const raw = body as Record<string, unknown>;
  const orgType = raw.org_type ?? raw.orgType;
  if (typeof orgType !== "string" || !ORG_TYPES.includes(orgType)) return { ok: false, error: "Choose your organisation type from the list." };
  let region: string | null = null;
  if (raw.region !== undefined && raw.region !== null && raw.region !== "") {
    if (typeof raw.region !== "string" || !REGION_CODES.includes(raw.region)) return { ok: false, error: "Choose your region from the list." };
    region = raw.region;
  }
  const anon = raw.default_anonymous ?? raw.defaultAnonymous;
  if (anon !== undefined && anon !== null && typeof anon !== "boolean") return { ok: false, error: "default_anonymous must be a boolean" };
  return { ok: true, data: { org_type: orgType, role: trimmedOrNull(raw.role, MAX_ROLE_LEN), sector: trimmedOrNull(raw.sector, MAX_SECTOR_LEN), region, default_anonymous: anon === true } };
}

type ProfileRow = { org_type?: string | null; role?: string | null; sector?: string | null; region?: string | null; verified?: boolean | null; verified_at?: string | null; verification_method?: string | null; default_anonymous?: boolean | null };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The member's own row as the form reads it; a missing row is the empty profile (a member who has declared nothing yet). */
export function projectOwnProfile(row: ProfileRow | null | undefined): OwnProfile {
  return {
    orgType: str(row?.org_type),
    role: str(row?.role),
    sector: str(row?.sector),
    region: str(row?.region),
    verified: row?.verified === true,
    verifiedAt: str(row?.verified_at),
    verificationMethod: str(row?.verification_method),
    defaultAnonymous: row?.default_anonymous === true,
  };
}
