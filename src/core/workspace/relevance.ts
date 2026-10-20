// Ported from old_repo/src/lib/workspace/relevance.mjs (lines 1-280)
// Ported from old_repo/src/lib/workspace/profile.ts (lines 103-127)
import type { Db } from "@/core/db/clients";
import { LookupError } from "@/core/http/errors";
import { boundedRead, MAX_BOUND } from "@/core/db/query";
import { resolveItemUuid } from "@/core/shared/ids";

import { deriveRoleScopeFromComplianceObjectTags, findBand, ORG_ROLES, ORG_SIZE_DIMENSIONS, type OrgProfile, type WorkspaceProfile } from "./profile";

/** The subset of intelligence_items columns the lens reads. */
export interface RelevanceInput {
  title?: string | null;
  transport_modes?: string[] | null;
  jurisdictions?: string[] | null;
  jurisdiction_iso?: string[] | null;
  topic_tags?: string[] | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
}

export interface ItemApplicability {
  status: "applies" | "does_not_apply" | "needs_profile_input";
  reasons: string[];
  missingDimensions: string[];
}
export interface SizeThreshold {
  dimension: string;
  band: string;
  comparison?: "below" | "at_least";
}
export interface Obligation {
  roleScope?: string[];
  sizeThreshold?: SizeThreshold;
}
export interface SectorDefinition {
  id: string;
  label?: string;
  keywords?: readonly string[];
}

/**
 * What the lens needs from slices that are not merged here; the caller (P2-08's wiring) supplies them.
 * computeApplicability is P1-19's core/applicability, the two tables are P2-04's core/contracts vocabularies, sectors is the sector list.
 */
export interface RelevanceDeps {
  computeApplicability: (obligation: Obligation, profile: OrgProfile) => ItemApplicability;
  dutyHolderClasses: Readonly<Record<string, { label: string; orgRoles: readonly string[] }>>;
  bindingPosition: Readonly<Record<string, { code: string; label: string; note: string; order: number }>>;
  sectors: readonly SectorDefinition[];
}

export interface ObligationObject {
  obligation_id?: string;
  supersedes?: string | null;
  binding_position?: string | null;
  duty_holder_class?: string[] | null;
  applicability_trigger?: { attribute?: string; value?: string; comparison?: string } | null;
  statutory_maximum?: string | null;
  cost_formula?: string | null;
  direct_compliance_cost?: { amount?: number; currency?: string; basis?: string; source?: string } | null;
  effort?: { person_days?: number; recurrence?: string } | null;
  [key: string]: unknown;
}

export interface BindingLine {
  position: string;
  label: string;
  note: string;
  dutyHolders: { id: string; label: string }[];
  triggers: { attribute: string; value: string | undefined; label: string }[];
  applicability: ItemApplicability | null;
  objectCount: number;
  costSlots: { slot: string; label: string; entries: string[] }[];
}
export interface ObligationBinding {
  decomposed: boolean;
  objectCount: number;
  applicability: (ItemApplicability & { grain: "obligation" }) | null;
  lines: BindingLine[];
}
export interface ItemRelevance {
  band: "high" | "medium" | "low";
  matchedModes: string[];
  matchedVerticals: { id: string; label: string }[];
  matchedJurisdictions: string[];
  roleSignals: string[];
  summary: string;
  applicability: ItemApplicability | null;
  binding: ObligationBinding;
}

const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim() !== "") : []);
const lc = (s: unknown): string => String(s || "").toLowerCase();
const uniq = <T>(a: T[]): T[] => [...new Set(a)];

const DEFAULT_SIZE = { headcount_band: null, revenue_band: null, shipment_volume_band: null };
const ORG_ROLE_LABEL = Object.fromEntries(ORG_ROLES.map((r) => [r.id, r.label]));
const APPLICABILITY_RANK = { applies: 0, needs_profile_input: 1, does_not_apply: 2 } as const;

/** True when a duty-holder class list names no class that maps to the forwarder role (the monitoring_only test). */
export function dutyHoldersExcludeForwarder(classes: unknown, dutyHolderClasses: RelevanceDeps["dutyHolderClasses"]): boolean {
  const list = arr(classes);
  if (!list.length) return false;
  return !list.some((c) => (dutyHolderClasses[c]?.orgRoles ?? []).includes("forwarder"));
}

function triggerLabel(trigger: { attribute?: string; value?: string; comparison?: string }): string {
  const { attribute = "", value } = trigger;
  if (attribute === "org_role") return `Your organisation role is ${ORG_ROLE_LABEL[value ?? ""] ?? value}`;
  const dim = ORG_SIZE_DIMENSIONS[attribute];
  if (dim) {
    const band = findBand(attribute, value);
    return `${dim.label} is ${trigger.comparison === "below" ? "below" : "at least"} ${band ? band.label : value}`;
  }
  return "A condition your profile does not describe";
}

/** One object's gate inputs: the roles its duty-holder classes map to plus an org_role trigger, a size trigger, or an unsupported attribute. */
function objectGateInputs(object: ObligationObject, deps: RelevanceDeps) {
  const trigger = object.applicability_trigger && typeof object.applicability_trigger === "object" ? object.applicability_trigger : {};
  const roles = arr(object.duty_holder_class).flatMap((c) => [...(deps.dutyHolderClasses[c]?.orgRoles ?? [])]);
  let sizeThreshold: SizeThreshold | undefined;
  let unsupported: string | undefined;
  if (trigger.attribute === "org_role" && ORG_ROLES.some((r) => r.id === trigger.value)) roles.push(trigger.value as string);
  else if (trigger.attribute && ORG_SIZE_DIMENSIONS[trigger.attribute] && findBand(trigger.attribute, trigger.value)) {
    sizeThreshold = { dimension: trigger.attribute, band: trigger.value as string, comparison: trigger.comparison === "below" ? "below" : "at_least" };
  } else if (typeof trigger.attribute === "string" && trigger.attribute) unsupported = trigger.attribute;
  return { roleScope: uniq(roles), sizeThreshold, unsupported };
}

function objectApplicability(object: ObligationObject, orgProfile: OrgProfile, deps: RelevanceDeps): ItemApplicability {
  const g = objectGateInputs(object, deps);
  const result = deps.computeApplicability({ ...(g.roleScope.length ? { roleScope: g.roleScope } : {}), ...(g.sizeThreshold ? { sizeThreshold: g.sizeThreshold } : {}) }, orgProfile);
  if (g.unsupported && result.status !== "does_not_apply") {
    return {
      status: "needs_profile_input",
      reasons: [...(result.status === "needs_profile_input" ? result.reasons : []), "This obligation applies by a condition your profile does not hold."],
      missingDimensions: uniq([...result.missingDimensions, g.unsupported]),
    };
  }
  return result;
}

function aggregateApplicability(results: ItemApplicability[]): ItemApplicability | null {
  const best = [...results].sort((a, b) => APPLICABILITY_RANK[a.status] - APPLICABILITY_RANK[b.status])[0];
  if (!best) return null;
  const same = results.filter((r) => r.status === best.status);
  return { status: best.status, reasons: uniq(same.flatMap((r) => r.reasons)), missingDimensions: uniq(same.flatMap((r) => r.missingDimensions)) };
}

const SLOT_LABELS: Record<string, string> = { penalty_exposure: "Penalty exposure", direct_compliance_cost: "Direct compliance cost", effort: "Effort (person-days, not money)" };

/** One direct-cost entry: the fields it has, in order, never the word undefined for one it lacks. */
const directCostLine = (d: { amount?: number; currency?: string; basis?: string; source?: string }): string => {
  const base = [`${d.amount}${d.currency ? ` ${d.currency}` : ""}`, d.basis].filter(Boolean).join(", ");
  return d.source ? `${base} (source: ${d.source})` : base;
};

/** The three cost slots of spec 01 section 3.4, carried separately and never merged; a slot with nothing to show is omitted. */
function costSlotsFor(objects: ObligationObject[]) {
  const penalty: string[] = [];
  const direct: string[] = [];
  const effort: string[] = [];
  for (const o of objects) {
    if (typeof o.statutory_maximum === "string" && o.statutory_maximum.trim()) penalty.push(o.statutory_maximum.trim());
    if (typeof o.cost_formula === "string" && o.cost_formula.trim()) penalty.push(`Formula: ${o.cost_formula.trim()}`);
    const d = o.direct_compliance_cost;
    if (d && typeof d === "object" && typeof d.amount === "number") direct.push(directCostLine(d));
    const e = o.effort;
    if (e && typeof e === "object" && typeof e.person_days === "number") effort.push(`${e.person_days} person-days, ${e.recurrence}`);
  }
  return (
    [
      ["penalty_exposure", penalty],
      ["direct_compliance_cost", direct],
      ["effort", effort],
    ] as const
  )
    .map(([slot, entries]) => ({ slot, label: SLOT_LABELS[slot] ?? slot, entries: uniq(entries) }))
    .filter((s) => s.entries.length > 0);
}

/** Summarise an item's obligation objects for the binding banner and the gate. Pure. */
export function summariseObligationBinding(objects: unknown, orgProfile: Partial<OrgProfile>, deps: RelevanceDeps): ObligationBinding {
  const list = (Array.isArray(objects) ? objects : []).filter((o): o is ObligationObject => !!o && typeof o === "object");
  if (!list.length) return { decomposed: false, objectCount: 0, applicability: null, lines: [] };
  const profile: OrgProfile = { orgRoles: arr(orgProfile.orgRoles), orgSize: orgProfile.orgSize && typeof orgProfile.orgSize === "object" ? orgProfile.orgSize : DEFAULT_SIZE };
  const perObject = list.map((o) => ({ object: o, applicability: objectApplicability(o, profile, deps) }));
  const order = Object.values(deps.bindingPosition)
    .sort((a, b) => a.order - b.order)
    .map((p) => p.code);
  const positions = uniq(list.map((o) => o.binding_position).filter((p): p is string => !!p));
  positions.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const lines: BindingLine[] = positions.map((position) => {
    const group = perObject.filter((p) => p.object.binding_position === position);
    const triggers: BindingLine["triggers"] = [];
    const seen = new Set<string>();
    for (const { object } of group) {
      const t = object.applicability_trigger;
      if (!t || typeof t !== "object" || !t.attribute) continue;
      const key = `${t.attribute}|${t.value}|${t.comparison ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      triggers.push({ attribute: t.attribute, value: t.value, label: triggerLabel(t) });
    }
    return {
      position,
      label: deps.bindingPosition[position]?.label ?? position,
      note: deps.bindingPosition[position]?.note ?? "",
      dutyHolders: uniq(group.flatMap((p) => arr(p.object.duty_holder_class))).map((id) => ({ id, label: deps.dutyHolderClasses[id]?.label ?? id })),
      triggers,
      applicability: aggregateApplicability(group.map((p) => p.applicability)),
      objectCount: group.length,
      costSlots: costSlotsFor(group.map((p) => p.object)),
    };
  });
  const applicability = aggregateApplicability(perObject.map((p) => p.applicability));
  return { decomposed: true, objectCount: list.length, applicability: applicability ? { ...applicability, grain: "obligation" } : null, lines };
}

/** Keep only the current version of each object: drop any row another row names in `supersedes`. Pure. */
export function currentObligationObjects<T extends { obligation_id?: string; supersedes?: string | null }>(rows: unknown): T[] {
  const list = (Array.isArray(rows) ? rows : []) as T[];
  const superseded = new Set(list.map((r) => r?.supersedes).filter(Boolean));
  return list.filter((r) => r && !superseded.has(r.obligation_id ?? ""));
}

const OBLIGATION_OBJECT_COLUMNS =
  "obligation_id, version, supersedes, pinpoint_citation, binding_position, duty_holder_class, applicability_trigger, statutory_maximum, cost_formula, direct_compliance_cost, effort";

/**
 * An item's current obligation objects through an INJECTED client (request-scoped, RLS applies). `itemId` is a uuid or a legacy id.
 * Resolves [] for an id that does not resolve; THROWS on a read error or a cut-off read, so the caller says the load failed
 * instead of claiming the item has no obligations.
 */
export async function fetchObligationObjectsForItem(client: Db, itemId: string, { limit = MAX_BOUND }: { limit?: number } = {}): Promise<ObligationObject[]> {
  if (!itemId) return [];
  const uuid = await resolveItemUuid(client, itemId);
  if (!uuid) return [];
  const read = await boundedRead((n) => client.from("obligation_objects").select(OBLIGATION_OBJECT_COLUMNS).eq("instrument_item_id", uuid).limit(n), { limit });
  if (read.error) throw new LookupError("obligation_objects", read.error);
  if (read.truncated) throw new LookupError("obligation_objects", { message: `obligation objects for ${uuid} reached the ${limit}-row bound; the list would be incomplete` });
  return currentObligationObjects<ObligationObject>(read.data);
}

// Import/export/customs signals: the forwarder, importer and exporter roles all engage.
const ROLE_SIGNAL_RE = /\b(import|export|customs|declaration|clearance|tariff|duty|duties|hs code|origin|incoterm|manifest|carrier|forwarder|consignee|consignor|transit|cross-border|border)\b/;

export interface LensProfile {
  transport_modes?: unknown;
  jurisdictions?: unknown;
  verticals?: unknown;
  roles?: unknown;
  orgRoles?: unknown;
  orgSize?: unknown;
}

/** The read-time lens for one item against a profile: band, matches, a deterministic summary line, and the applicability gate. */
export function computeItemRelevance(item: Record<string, unknown>, profile: LensProfile, deps: RelevanceDeps): ItemRelevance {
  const pModes = arr(profile.transport_modes);
  const iModes = arr(item.transport_modes);
  // An item that declares no modes is mode-agnostic (applies across the reader's modes), not "no match".
  const matchedModes = iModes.filter((m) => pModes.some((pm) => lc(pm) === lc(m)));
  const modeAgnostic = iModes.length === 0;

  const weights = profile.jurisdictions && typeof profile.jurisdictions === "object" ? (profile.jurisdictions as Record<string, number>) : {};
  const globalScope = (weights.global ?? 0) > 0 || Object.keys(weights).length === 0;
  const iJur = uniq([...arr(item.jurisdictions), ...arr(item.jurisdiction_iso)]);
  const matchedJurisdictions = iJur.filter((j) => globalScope || Object.keys(weights).some((w) => lc(w) === lc(j) && (weights[w] ?? 0) > 0));

  const hay = lc([item.title, ...arr(item.topic_tags), ...arr(item.operational_scenario_tags), ...arr(item.compliance_object_tags)].join(" "));
  const pVerticals = new Set(arr(profile.verticals).map(lc));
  const matchedVerticals = deps.sectors.filter((s) => s && pVerticals.has(lc(s.id)) && arr(s.keywords).some((k) => hay.includes(lc(k)))).map((s) => ({ id: s.id, label: s.label || s.id }));

  const roleHay = lc([item.title, ...arr(item.compliance_object_tags), ...arr(item.operational_scenario_tags)].join(" "));
  const roleSignals = ROLE_SIGNAL_RE.test(roleHay) ? arr(profile.roles) : [];

  // A lens, not a gate: HIGH when the item touches modes and jurisdictions AND a vertical or role signal; MEDIUM on a partial touch; LOW otherwise.
  const touchesModes = matchedModes.length > 0 || modeAgnostic;
  const touchesGeo = matchedJurisdictions.length > 0 || globalScope;
  const touchesFocus = matchedVerticals.length > 0 || roleSignals.length > 0;
  const band = touchesModes && touchesGeo && touchesFocus ? "high" : (touchesModes || touchesGeo) && (touchesFocus || matchedModes.length || matchedJurisdictions.length) ? "medium" : "low";

  const parts: string[] = [];
  if (matchedModes.length) parts.push(`your ${matchedModes.join("/")} operations`);
  else if (modeAgnostic) parts.push("your operations across modes");
  if (matchedVerticals.length) parts.push(`the ${matchedVerticals.map((v) => v.label).join(", ")} ${matchedVerticals.length === 1 ? "vertical" : "verticals"}`);
  if (roleSignals.length) parts.push(`your role as ${roleSignals.join("/")}`);
  const shown = globalScope ? (matchedJurisdictions.length && matchedJurisdictions.length <= 4 ? matchedJurisdictions : []) : matchedJurisdictions.slice(0, 4);
  const geo = shown.length ? ` in ${shown.join(", ")}` : "";
  const summary = parts.length ? `Relevance to your operation: affects ${parts.join(", ")}${geo}.` : "Relevance to your operation: general applicability to a freight operator.";

  // Item-grain gate: an obligation derived from the item's own compliance_object_tags (roleScope is undefined, not [], when nothing mapped).
  const derivedRoleScope = deriveRoleScopeFromComplianceObjectTags(item.compliance_object_tags);
  const obligation: Obligation = {
    ...(derivedRoleScope.length ? { roleScope: derivedRoleScope } : {}),
    ...(item.size_threshold && typeof item.size_threshold === "object" ? { sizeThreshold: item.size_threshold as SizeThreshold } : {}),
  };
  const orgProfile: OrgProfile = { orgRoles: arr(profile.orgRoles), orgSize: profile.orgSize && typeof profile.orgSize === "object" ? (profile.orgSize as OrgProfile["orgSize"]) : DEFAULT_SIZE };
  // Obligation grain when the item has decomposed objects; the item-grain gate is the fallback.
  const binding = summariseObligationBinding(item.obligation_objects, orgProfile, deps);
  const applicability = binding.decomposed ? binding.applicability : deps.computeApplicability(obligation, orgProfile);
  return { band, matchedModes, matchedVerticals, matchedJurisdictions, roleSignals, summary, applicability, binding };
}

/** The lens for one item against a workspace profile. */
export function relevanceForItem(item: Record<string, unknown>, profile: WorkspaceProfile, deps: RelevanceDeps): ItemRelevance {
  return computeItemRelevance(item, { transport_modes: profile.transportModes, jurisdictions: profile.jurisdictions, verticals: profile.verticals, roles: profile.roles, orgRoles: profile.orgRoles, orgSize: profile.orgSize }, deps);
}
