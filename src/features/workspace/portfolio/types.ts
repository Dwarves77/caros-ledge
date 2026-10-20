// Ported from old_repo/src/lib/portfolio/types.ts (lines 1-50)
// Ported from old_repo/src/lib/portfolio/portfolio-core.mjs (lines 1-60)
export type PortfolioSurfaceKey = "regulations" | "market" | "research" | "operations";

export const PORTFOLIO_NAME_MAX = 80;
/** Mirrors the migration 362 caps (the database trigger is the authority; these keep reads bounded). */
export const PORTFOLIO_LIST_CAP = 100;
export const PORTFOLIO_MEMBER_CAP = 500;
const MEMBER_KINDS = ["item", "corridor", "entity"] as const;
export const SURFACE_KEYS: readonly PortfolioSurfaceKey[] = ["regulations", "market", "research", "operations"];
const PRIORITY_KEYS = ["CRITICAL", "HIGH", "MODERATE", "LOW"] as const;

export interface PortfolioRow {
  id: string;
  name: string;
  createdAt: string;
}
export interface PortfolioSummary extends PortfolioRow {
  memberCount: number;
}
export interface MemberDbRow {
  id: string;
  member_kind: string;
  item_id: string | null;
  entity_id: string | null;
  added_at: string;
}
export interface MemberRow {
  id: string;
  kind: string;
  itemId: string | null;
  entityId: string | null;
  addedAt: string;
}
export type MemberInput = { kind: "item"; itemId: string } | { kind: "corridor" | "entity"; entityId: string };

export interface Rollup {
  total: number;
  items: { members: number; held: number; notHeld: string[] };
  entities: { corridors: number; other: number };
  bySurface: Record<PortfolioSurfaceKey, number>;
  otherSurface: number;
  byPriority: { CRITICAL: number; HIGH: number; MODERATE: number; LOW: number; unscored: number };
  nextDue: { itemId: string; days: number } | null;
  origin: { weakest: string | null; classified: number; unclassified: number };
}

/** A member item that is currently held, read through the surface read layer (not merged here), already classified to a surface. */
export interface HeldRow {
  /** The UI id of the item: its legacy id, else its uuid. */
  uiId: string;
  title: string;
  priority: string | null;
  surface: PortfolioSurfaceKey;
  /** Days to the nearest future binding date, or null. */
  dueDays: number | null;
  /** The list-row fields the surface renders, passed through untouched. */
  fields: Record<string, unknown>;
}

/** What the detail read needs from slices that are not merged here; P2-08 wires them. */
export interface PortfolioDeps {
  /** The held rows (verified, not archived, this workspace's overrides applied) for these item uuids; at most 40 per call is the read layer's bound, so the caller chunks. */
  heldItems: (orgId: string, itemUuids: string[], now: Date) => Promise<HeldRow[]>;
  /** The "A to B" label of a corridor canonical name, or null when it does not parse. */
  corridorLabel: (canonicalName: string) => string | null;
  /** The weakest origin class in a list, or null for an empty list (the contracts vocabulary). */
  weakestOriginClass: (classes: string[]) => string | null;
}

export interface PortfolioItemRow extends HeldRow {
  /** intelligence_items.id. */
  itemUuid: string;
  /** intelligence_items.origin_class, or null when the item carries none (counted as unclassified). */
  originClass: string | null;
}
export interface PortfolioEntityRow {
  entityId: string;
  kind: "corridor" | "entity";
  /** The spine kind word, for example "jurisdiction" or "corridor". */
  entityKind: string;
  /** Always a real name: display name, else a composed corridor label, else the canonical name. */
  label: string;
}
export interface PortfolioDetailView {
  portfolio: PortfolioRow;
  rollup: Rollup;
  groups: Array<{ surface: PortfolioSurfaceKey; rows: PortfolioItemRow[] }>;
  entityRows: PortfolioEntityRow[];
  /** Member entities that could not be read (should be none; counted so the denominator stays honest). */
  entitiesUnread: number;
}
