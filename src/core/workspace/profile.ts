// Ported from old_repo/src/lib/workspace/profile.ts (lines 1-127)
import type { Db } from "@/core/db/clients";
import { describeError } from "@/core/db/clients";
import { LookupError } from "@/core/http/errors";
import { log } from "@/core/shared/log";

import { DEFAULT_ORG_PROFILE, parseOrgProfile, type OrgSize } from "./org-profile";

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
