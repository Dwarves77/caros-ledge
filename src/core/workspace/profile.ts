// Ported from old_repo/src/lib/workspace/profile.ts (lines 1-127)
// Ported from old_repo/src/lib/profile/profile-contract.mjs (lines 1-162)
import { z } from "zod";

import type { Db } from "@/core/db/clients";
import { describeError } from "@/core/db/clients";
import { LookupError } from "@/core/http/errors";
import { log } from "@/core/shared/log";

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
const DEFAULT_ORG_PROFILE: Readonly<OrgProfile> = Object.freeze({
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

export interface WorkspaceProfile {
  /** Free-text roles from workspace_settings.profile.roles; they gate the role-signal line of the lens. */
  roles: string[];
  transportModes: string[];
  /** Cargo verticals: workspace_settings.sector_profile. */
  verticals: string[];
  /** jurisdiction to weight, from workspace_settings.jurisdiction_weights. */
  jurisdictions: Record<string, number>;
  /** ADR-034 controlled-vocabulary roles and size bands, parsed from workspace_settings.profile. */
  orgRoles: string[];
  orgSize: OrgSize;
}

/** A conservative default for a viewer with no configured profile: a general freight operator, worldwide. It never invents verticals. */
const DEFAULT_WORKSPACE_PROFILE: Readonly<WorkspaceProfile> = Object.freeze({
  roles: ["freight operator"],
  transportModes: ["air", "ocean", "road"],
  verticals: [],
  jurisdictions: { global: 1 },
  orgRoles: [],
  orgSize: DEFAULT_ORG_PROFILE.orgSize,
});

const strings = (v: unknown, fallback: string[]): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback);

/**
 * The viewer's workspace profile. A null org or an absent row gives the default (a generic lens is still useful); a failed read gives the default AND `failed: true`, logged with its full diagnostic
 * surface, so the page states that it is ranked without the profile (INV-263).
 */
export async function readWorkspaceProfile(client: Db, orgId: string | null): Promise<{ profile: WorkspaceProfile; failed: boolean }> {
  if (!orgId) return { profile: DEFAULT_WORKSPACE_PROFILE, failed: false };
  const { data, error } = await client.from("workspace_settings").select("sector_profile, jurisdiction_weights, profile").eq("org_id", orgId).maybeSingle();
  if (error) {
    log.warn(`[workspace-profile] read failed for org ${orgId}, using the default profile: ${describeError(error)}`);
    return { profile: DEFAULT_WORKSPACE_PROFILE, failed: true };
  }
  if (!data) return { profile: DEFAULT_WORKSPACE_PROFILE, failed: false };
  const p = (data.profile && typeof data.profile === "object" ? data.profile : {}) as Record<string, unknown>;
  const weights = data.jurisdiction_weights;
  const org = parseOrgProfile(data.profile);
  return {
    failed: false,
    profile: {
      roles: strings(p.roles, DEFAULT_WORKSPACE_PROFILE.roles),
      transportModes: strings(p.transport_modes, DEFAULT_WORKSPACE_PROFILE.transportModes),
      verticals: strings(data.sector_profile, []),
      jurisdictions: weights && typeof weights === "object" && !Array.isArray(weights) ? (weights as Record<string, number>) : DEFAULT_WORKSPACE_PROFILE.jurisdictions,
      orgRoles: org.orgRoles,
      orgSize: org.orgSize,
    },
  };
}

/** The viewer's workspace profile for the callers that rank (relevance, upcoming obligations). A failed read is a LookupError to the caller's failure state, never the default profile presented as the viewer's own lens (W:20). */
export async function getWorkspaceProfile(client: Db, orgId: string | null): Promise<WorkspaceProfile> {
  const read = await readWorkspaceProfile(client, orgId);
  if (read.failed) throw new LookupError("workspace_settings", { message: "the workspace profile could not be read" });
  return read.profile;
}
