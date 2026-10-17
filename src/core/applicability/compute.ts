// Ported from old_repo/src/lib/applicability/compute-applicability.mjs (lines 1-90)
// The applicability gate: does an obligation reach an organisation, given the roles it holds and its size bands. It is the function P2-02's RelevanceDeps.computeApplicability names.
// An unset profile dimension is "needs profile input", never an assumed default; an obligation that names an unknown dimension cannot gate anything (it fails open on the gate itself).
import { findBand, ORG_SIZE_DIMENSIONS, type OrgProfile } from "@/core/workspace/profile";
import type { ItemApplicability, Obligation } from "@/core/workspace/relevance";

type Check = "pass" | "fail" | "needs_input";

function roleCheck(roleScope: readonly string[] | undefined, orgRoles: readonly string[]): Check {
  if (!Array.isArray(roleScope) || roleScope.length === 0) return "pass";
  if (orgRoles.length === 0) return "needs_input";
  return roleScope.some((r) => orgRoles.includes(r)) ? "pass" : "fail";
}

function sizeCheck(threshold: Obligation["sizeThreshold"], orgSize: Partial<OrgProfile["orgSize"]>): { result: Check; dimension?: string; reason?: string } {
  if (!threshold) return { result: "pass" };
  const { dimension, band, comparison } = threshold;
  const dim = ORG_SIZE_DIMENSIONS[dimension];
  const wanted = findBand(dimension, band);
  if (!dim || !wanted) return { result: "pass" };
  const own = findBand(dimension, orgSize[`${dimension}_band` as keyof OrgProfile["orgSize"]]);
  if (!own) return { result: "needs_input", dimension };
  const passes = comparison === "below" ? own.rank < wanted.rank : own.rank >= wanted.rank;
  return { result: passes ? "pass" : "fail", dimension, reason: `${dim.label}: your organisation is "${own.label}", threshold is ${comparison === "below" ? "below" : "at least"} "${wanted.label}"` };
}

export function computeApplicability(obligation: Obligation = {}, profile: Partial<OrgProfile> = {}): ItemApplicability {
  const orgRoles = Array.isArray(profile.orgRoles) ? profile.orgRoles : [];
  const roleResult = roleCheck(obligation.roleScope, orgRoles);
  const size = sizeCheck(obligation.sizeThreshold, profile.orgSize && typeof profile.orgSize === "object" ? profile.orgSize : {});
  const missing = [...(roleResult === "needs_input" ? ["role"] : []), ...(size.result === "needs_input" && size.dimension ? [size.dimension] : [])];
  if (missing.length > 0) {
    return {
      status: "needs_profile_input",
      reasons: missing.map((d) => (d === "role" ? "Your organisation's role is not set, add it in your profile to see whether this applies to you." : `Your organisation's ${ORG_SIZE_DIMENSIONS[d]?.label.toLowerCase() ?? d} is not set, add it in your profile to see whether this applies to you.`)),
      missingDimensions: missing,
    };
  }
  if (roleResult === "fail") return { status: "does_not_apply", reasons: ["Does not apply to any role your organisation holds."], missingDimensions: [] };
  if (size.result === "fail") return { status: "does_not_apply", reasons: [size.reason ?? "Below the applicability threshold for your organisation's size."], missingDimensions: [] };
  const reasons: string[] = [];
  if (obligation.roleScope?.length) reasons.push("Applies to your organisation's role.");
  if (size.reason) reasons.push(size.reason.replace("threshold is", "threshold met:"));
  return { status: "applies", reasons: reasons.length > 0 ? reasons : ["Applies, no role or size restriction on this obligation."], missingDimensions: [] };
}
