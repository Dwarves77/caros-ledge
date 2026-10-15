// Ported from old_repo/src/lib/domains.ts (lines 1-121)
export const DOMAIN_LABELS = {
  1: "Regulations",
  2: "Market Intel - Tech",
  3: "Operations - Regional",
  4: "Market Intel - Price/Signals",
  5: "(unused; legacy)",
  6: "Operations - Facility",
  7: "Research",
} as const;
export type Domain = keyof typeof DOMAIN_LABELS;

export const REGULATIONS_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([1]);
export const MARKET_INTEL_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([2, 4]);
export const OPERATIONS_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([3, 6]);
export const RESEARCH_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([7]);

export type SourceCategory = "regulatory" | "research" | "market_news" | "operational_data" | null | undefined;

/**
 * The item_type to domain routing, mirroring the CASE in migration 101. Returns null for an unrecognised type:
 * callers pass the null through and never coerce it to 1.
 */
export function domainForItemType(itemType: string | null | undefined, sourceCategory?: SourceCategory): Domain | null {
  switch (itemType) {
    case "regulation":
    case "directive":
    case "standard":
    case "guidance":
    case "law":
      return 1;
    case "framework":
      return sourceCategory === "research" ? 7 : sourceCategory === "market_news" ? 4 : sourceCategory === "operational_data" ? 3 : 1;
    case "research_finding":
      return 7;
    case "regional_data":
      return 3;
    case "market_signal":
      return 4;
    case "technology":
    case "innovation":
      return 2;
    case "tool":
      return sourceCategory === "research" ? 7 : sourceCategory === "operational_data" ? 3 : 2;
    case "initiative":
      return sourceCategory === "regulatory" ? 1 : sourceCategory === "research" ? 7 : sourceCategory === "operational_data" ? 3 : 4;
    default:
      return null;
  }
}

export function asDomain(value: unknown): Domain | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7 ? (value as Domain) : null;
}
