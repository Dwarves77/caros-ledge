import { findBand, ORG_SIZE_DIMENSIONS, type OrgProfile } from "@/core/workspace/org-profile";
import type { ItemApplicability, Obligation, RelevanceDeps } from "@/core/workspace/relevance";

// Stand-ins for the three things the lens receives from slices that are not merged here. They follow the old files' behaviour
// (compute-applicability.mjs, DUTY_HOLDER_CLASSES and BINDING_POSITION in vocabularies.mjs, ALL_SECTORS in constants.ts) closely enough
// to prove the lens against realistic inputs; the real ones are wired by P2-08.
export function computeApplicability(obligation: Obligation = {}, profile: Partial<OrgProfile> = {}): ItemApplicability {
  const orgRoles = profile.orgRoles ?? [];
  const missing: string[] = [];
  let roleResult: "pass" | "fail" | "needs" = "pass";
  if (obligation.roleScope?.length) roleResult = orgRoles.length === 0 ? "needs" : obligation.roleScope.some((r) => orgRoles.includes(r)) ? "pass" : "fail";
  if (roleResult === "needs") missing.push("role");
  let sizeResult: "pass" | "fail" | "needs" = "pass";
  const t = obligation.sizeThreshold;
  const dim = t ? ORG_SIZE_DIMENSIONS[t.dimension] : undefined;
  const threshold = t ? findBand(t.dimension, t.band) : undefined;
  if (t && dim && threshold) {
    const own = findBand(t.dimension, (profile.orgSize as Record<string, string | null> | undefined)?.[`${t.dimension}_band`]);
    if (!own) {
      sizeResult = "needs";
      missing.push(t.dimension);
    } else sizeResult = (t.comparison === "below" ? own.rank < threshold.rank : own.rank >= threshold.rank) ? "pass" : "fail";
  }
  if (missing.length) return { status: "needs_profile_input", reasons: missing.map((d) => `Your organisation's ${d} is not set.`), missingDimensions: missing };
  if (roleResult === "fail") return { status: "does_not_apply", reasons: ["Does not apply to any role your organisation holds."], missingDimensions: [] };
  if (sizeResult === "fail") return { status: "does_not_apply", reasons: ["Below the applicability threshold for your organisation's size."], missingDimensions: [] };
  return { status: "applies", reasons: ["Applies."], missingDimensions: [] };
}

export const relevanceDeps: RelevanceDeps = {
  computeApplicability,
  dutyHolderClasses: {
    carrier: { label: "Carrier", orgRoles: ["carrier"] },
    forwarder: { label: "Freight forwarder", orgRoles: ["forwarder"] },
    nvocc: { label: "NVOCC", orgRoles: ["forwarder"] },
    port_authority: { label: "Port authority", orgRoles: [] },
  },
  bindingPosition: {
    direct_duty: { code: "direct_duty", label: "Your duty", note: "Falls on the forwarder.", order: 1 },
    carrier_passthrough: { code: "carrier_passthrough", label: "Carrier pass-through", note: "Reaches you as a price.", order: 2 },
    monitoring_only: { code: "monitoring_only", label: "Monitor", note: "Watch only.", order: 4 },
  },
  sectors: [
    { id: "fine-art", label: "Fine Art & Museum Logistics", keywords: ["artwork", "gallery", "museum"] },
    { id: "pharma", label: "Pharmaceutical & Life Sciences", keywords: ["pharma", "vaccine"] },
  ],
};
