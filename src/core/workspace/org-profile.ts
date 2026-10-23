// Ported from old_repo/src/lib/workspace/profile.ts (lines 1-127)
// Ported from old_repo/src/lib/profile/profile-contract.mjs (lines 1-162)
// The organisation profile contract: the controlled vocabulary of roles and size bands, and the parsers. Pure (no database, no server module), so a client component may import it (scripts/ci/checks/client-walk.mjs); profile.ts reads the stored profile.
import { z } from "zod";

import vocabulary from "./data/org-vocabulary.json";

const bandSchema = z.object({ id: z.string().min(1), label: z.string().min(1), rank: z.number().int().min(0) });
const vocabularySchema = z.object({
  roles: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1),
  sizeDimensions: z.record(z.string(), z.object({ label: z.string().min(1), bands: z.array(bandSchema).min(2) })),
  complianceObjectToOrgRole: z.record(z.string(), z.string()),
});
const loaded = vocabularySchema.parse(vocabulary);
const roleIds = new Set(loaded.roles.map((r) => r.id));
for (const [tag, role] of Object.entries(loaded.complianceObjectToOrgRole)) {
  if (!roleIds.has(role)) throw new Error(`org-vocabulary.json: compliance tag "${tag}" maps to unknown role "${role}"`);
}

/** The eight ADR-034 organisation roles: the one vocabulary site. */
export const ORG_ROLES: readonly { id: string; label: string }[] = Object.freeze(loaded.roles);
/** Organisation-size dimensions (ADR-034 decision point 2): each an ordered band vocabulary; `rank` orders threshold comparison. */
export const ORG_SIZE_DIMENSIONS: Readonly<Record<string, { id: string; label: string; bands: readonly { id: string; label: string; rank: number }[] }>> = Object.freeze(
  Object.fromEntries(Object.entries(loaded.sizeDimensions).map(([id, d]) => [id, { id, label: d.label, bands: d.bands }])),
);

/** Band id to {id, label, rank} for one dimension, or undefined. */
export function findBand(dimension: string, bandId: string | null | undefined) {
  const dim = ORG_SIZE_DIMENSIONS[dimension];
  if (!dim || !bandId) return undefined;
  return dim.bands.find((b) => b.id === bandId);
}

/** The jsonb keys this module owns under workspace_settings.profile (migration 251). */
export const PROFILE_JSON_KEYS = Object.freeze({ orgRoles: "org_roles", orgSize: "org_size" });

export interface OrgSize {
  headcount_band: string | null;
  revenue_band: string | null;
  shipment_volume_band: string | null;
}
export interface OrgProfile {
  orgRoles: string[];
  orgSize: OrgSize;
}

/** Empty, never invented: an unset dimension is "needs profile input" downstream, never an assumed default. */
export const DEFAULT_ORG_PROFILE: Readonly<OrgProfile> = Object.freeze({
  orgRoles: [],
  orgSize: Object.freeze({ headcount_band: null, revenue_band: null, shipment_volume_band: null }),
});

/** Validate a candidate org-roles/org-size input before it is persisted. Unset bands are valid. */
export function validateProfileInput(input: { orgRoles?: unknown; orgSize?: unknown } = {}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const r of Array.isArray(input.orgRoles) ? input.orgRoles : []) if (!roleIds.has(r)) errors.push(`unknown role id: ${r}`);
  const orgSize = input.orgSize && typeof input.orgSize === "object" ? (input.orgSize as Record<string, unknown>) : {};
  for (const dimension of Object.keys(ORG_SIZE_DIMENSIONS)) {
    const value = orgSize[`${dimension}_band`];
    if (value == null) continue;
    if (typeof value !== "string" || !findBand(dimension, value)) errors.push(`unknown ${dimension} band id: ${String(value)}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Org roles an item's compliance_object_tags imply. A tag with no ORG_ROLES counterpart is dropped, never force-fitted
 * (rule 2); an empty result means "no role scope named".
 */
export function deriveRoleScopeFromComplianceObjectTags(tags: unknown): string[] {
  const map: Record<string, string> = loaded.complianceObjectToOrgRole;
  const mapped = (Array.isArray(tags) ? tags : []).map((t) => (typeof t === "string" ? map[t] : undefined)).filter((r): r is string => !!r);
  return [...new Set(mapped)];
}

/** Parse the raw workspace_settings.profile jsonb into {orgRoles, orgSize}. Malformed input falls back to the empty default per key. */
export function parseOrgProfile(rawProfileJson: unknown): OrgProfile {
  const p = rawProfileJson && typeof rawProfileJson === "object" ? (rawProfileJson as Record<string, unknown>) : {};
  const rolesRaw = p[PROFILE_JSON_KEYS.orgRoles];
  const sizeRaw = p[PROFILE_JSON_KEYS.orgSize];
  const size = sizeRaw && typeof sizeRaw === "object" ? (sizeRaw as Record<string, unknown>) : {};
  const band = (dimension: string): string | null => {
    const v = size[`${dimension}_band`];
    return typeof v === "string" && findBand(dimension, v) ? v : null;
  };
  return {
    orgRoles: Array.isArray(rolesRaw) ? rolesRaw.filter((r): r is string => typeof r === "string" && roleIds.has(r)) : [],
    orgSize: { headcount_band: band("headcount"), revenue_band: band("revenue"), shipment_volume_band: band("shipment_volume") },
  };
}
