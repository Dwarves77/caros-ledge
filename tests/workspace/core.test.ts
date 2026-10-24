import assert from "node:assert/strict";
import { test } from "node:test";

import { LookupError } from "@/core/http/errors";
import { itemIdFromDetailPath } from "@/core/workspace/paths";
import { canWrite, isOrgAdmin, loadRoster, orgWatchersOf } from "@/core/workspace/roster";
import {
  deriveRoleScopeFromComplianceObjectTags,
  findBand,
  ORG_ROLES,
  ORG_SIZE_DIMENSIONS,
  parseOrgProfile,
  PROFILE_JSON_KEYS,
  validateProfileInput,
} from "@/core/workspace/org-profile";
import { getWorkspaceProfile } from "@/core/workspace/profile";
import { currentObligationObjects, dutyHoldersExcludeForwarder, fetchObligationObjectsForItem, relevanceForItem, summariseObligationBinding } from "@/core/workspace/relevance";

import { relevanceDeps } from "./_deps.ts";
import { clientFor, ITEM_1, ORG_A, ORG_B, seed, USER } from "./_world.ts";

/** The documented defaults: nothing invented for an unset org profile; a general freight operator, worldwide, for a viewer with no profile. */
const DEFAULT_ORG_PROFILE = { orgRoles: [], orgSize: { headcount_band: null, revenue_band: null, shipment_volume_band: null } };
const DEFAULT_WORKSPACE_PROFILE = { roles: ["freight operator"], transportModes: ["air", "ocean", "road"], verticals: [], jurisdictions: { global: 1 }, orgRoles: [], orgSize: DEFAULT_ORG_PROFILE.orgSize };
/** The lens over a profile written in the lens's own keys: the workspace profile it is built from, field for field. */
const computeItemRelevance = (item: Record<string, unknown>, p: Record<string, unknown>, deps: Parameters<typeof relevanceForItem>[2]) =>
  relevanceForItem(item, { transportModes: p.transport_modes, jurisdictions: p.jurisdictions, verticals: p.verticals, roles: p.roles, orgRoles: p.orgRoles, orgSize: p.orgSize } as never, deps);

// ── profile-contract ─────────────────────────────────────────────────────────────────────────────────

test("ORG_ROLES carries the eight ADR-034 role ids; ORG_SIZE_DIMENSIONS carries three ordered band vocabularies", () => {
  assert.deepEqual(ORG_ROLES.map((r) => r.id), ["shipper", "importer_of_record", "exporter", "forwarder", "carrier", "warehouse_operator", "lender_borrower_of_goods", "public_body"]);
  assert.deepEqual(Object.keys(ORG_SIZE_DIMENSIONS), ["headcount", "revenue", "shipment_volume"]);
  for (const dim of Object.values(ORG_SIZE_DIMENSIONS)) assert.deepEqual(dim.bands.map((b) => b.rank), [0, 1, 2, 3]);
  assert.ok(Object.isFrozen(ORG_ROLES));
});

test("findBand resolves a known band and returns undefined for an unknown one", () => {
  assert.equal(findBand("headcount", "medium")?.rank, 2);
  assert.equal(findBand("headcount", "huge"), undefined);
  assert.equal(findBand("nope", "medium"), undefined);
  assert.equal(findBand("headcount", null), undefined);
});

test("validateProfileInput accepts a well-formed profile, rejects unknown role and band ids, and treats unset bands as valid", () => {
  assert.deepEqual(validateProfileInput({ orgRoles: ["forwarder", "carrier"], orgSize: { headcount_band: "small", revenue_band: null } }), { valid: true, errors: [] });
  const bad = validateProfileInput({ orgRoles: ["wizard"], orgSize: { headcount_band: "huge", shipment_volume_band: "low" } });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors, ["unknown role id: wizard", "unknown headcount band id: huge"]);
  assert.equal(validateProfileInput().valid, true);
});

test("parseOrgProfile falls back to the empty default on malformed input, reads PROFILE_JSON_KEYS, drops unknown vocabulary, and does not touch the free-text roles key", () => {
  assert.deepEqual(parseOrgProfile(null), DEFAULT_ORG_PROFILE);
  assert.deepEqual(parseOrgProfile("garbage"), DEFAULT_ORG_PROFILE);
  assert.deepEqual(parseOrgProfile({ org_roles: "forwarder", org_size: 7 }), DEFAULT_ORG_PROFILE);
  const parsed = parseOrgProfile({ [PROFILE_JSON_KEYS.orgRoles]: ["forwarder", "wizard"], [PROFILE_JSON_KEYS.orgSize]: { headcount_band: "large", revenue_band: "enormous" }, roles: ["freight operator"] });
  assert.deepEqual(parsed, { orgRoles: ["forwarder"], orgSize: { headcount_band: "large", revenue_band: null, shipment_volume_band: null } });
  assert.deepEqual(parseOrgProfile({ roles: ["freight operator"] }).orgRoles, []);
});

test("compliance_object_tags map to org roles; unmapped tags are dropped, never force-fitted", () => {
  assert.deepEqual(deriveRoleScopeFromComplianceObjectTags(["carrier-ocean", "carrier-air", "nvocc", "port-operator", "customs-broker"]), ["carrier", "forwarder", "importer_of_record"]);
  assert.deepEqual(deriveRoleScopeFromComplianceObjectTags(["port-operator", "distributor"]), []);
  assert.deepEqual(deriveRoleScopeFromComplianceObjectTags("carrier-ocean"), []);
});

// ── profile ──────────────────────────────────────────────────────────────────────────────────────────

test("getWorkspaceProfile: the default for a null org and an absent row, a LookupError for a failed read (never the default as the viewer's own lens); the stored profile otherwise; no dead fields", async () => {
  const db = seed();
  const client = clientFor(db);
  assert.deepEqual(await getWorkspaceProfile(client, null), DEFAULT_WORKSPACE_PROFILE);
  assert.deepEqual(await getWorkspaceProfile(client, "33333333-3333-4333-8333-333333333333"), DEFAULT_WORKSPACE_PROFILE);
  db.fail("workspace_settings", "select", { message: "down" });
  await assert.rejects(getWorkspaceProfile(client, ORG_A), LookupError);
  db.failures.length = 0;
  Object.assign(db.rows("workspace_settings")[0]!, { sector_profile: ["fine-art"], jurisdiction_weights: { EU: 2 }, profile: { roles: ["importer"], transport_modes: ["air"], org_roles: ["forwarder"], org_size: { headcount_band: "small" } } });
  const profile = await getWorkspaceProfile(client, ORG_A);
  assert.deepEqual(profile, { roles: ["importer"], transportModes: ["air"], verticals: ["fine-art"], jurisdictions: { EU: 2 }, orgRoles: ["forwarder"], orgSize: { headcount_band: "small", revenue_band: null, shipment_volume_band: null } });
  assert.deepEqual(Object.keys(profile).sort(), ["jurisdictions", "orgRoles", "orgSize", "roles", "transportModes", "verticals"]);
});

test("getWorkspaceProfile: a malformed stored profile falls back per key instead of failing", async () => {
  const db = seed();
  Object.assign(db.rows("workspace_settings")[0]!, { sector_profile: "nope", jurisdiction_weights: ["x"], profile: { roles: 5, transport_modes: null } });
  const profile = await getWorkspaceProfile(clientFor(db), ORG_A);
  assert.deepEqual([profile.roles, profile.transportModes, profile.verticals, profile.jurisdictions], [DEFAULT_WORKSPACE_PROFILE.roles, DEFAULT_WORKSPACE_PROFILE.transportModes, [], DEFAULT_WORKSPACE_PROFILE.jurisdictions]);
});

// ── relevance ────────────────────────────────────────────────────────────────────────────────────────

const lens = (item: Record<string, unknown>, profile: Record<string, unknown> = {}) => computeItemRelevance(item, { transport_modes: ["ocean", "air"], jurisdictions: { global: 1 }, verticals: ["fine-art"], roles: ["freight operator"], ...profile }, relevanceDeps);

test("mode + vertical + geo match gives the high band and a summary that names them", () => {
  const r = lens({ title: "Museum artwork transit rules", transport_modes: ["ocean"], jurisdictions: ["EU"], topic_tags: ["artwork"] });
  assert.equal(r.band, "high");
  assert.deepEqual([r.matchedModes, r.matchedVerticals.map((v) => v.id), r.matchedJurisdictions], [["ocean"], ["fine-art"], ["EU"]]);
  assert.match(r.summary, /your ocean operations, the Fine Art & Museum Logistics vertical, your role as freight operator in EU/);
});

test("an item that declares no modes applies across modes; a global profile puts every jurisdiction in scope", () => {
  const r = lens({ title: "x", jurisdictions: ["US-CA", "SG"] });
  assert.deepEqual([r.matchedModes, r.matchedJurisdictions], [[], ["US-CA", "SG"]]);
  assert.match(r.summary, /your operations across modes/);
});

test("a weighted profile keeps only the jurisdictions it weights above zero", () => {
  const r = lens({ title: "x", transport_modes: ["ocean"], jurisdictions: ["EU", "SG"] }, { jurisdictions: { eu: 2, SG: 0 } });
  assert.deepEqual(r.matchedJurisdictions, ["EU"]);
});

test("empty and degenerate inputs never throw and give a safe general result", () => {
  const r = computeItemRelevance({}, {}, relevanceDeps);
  assert.deepEqual([r.band, r.matchedModes, r.matchedVerticals, r.roleSignals], ["low", [], [], []]);
  assert.match(r.summary, /operations across modes/);
  assert.equal(computeItemRelevance({ transport_modes: "air", topic_tags: 4 }, {}, relevanceDeps).band, "low");
  const mismatch = lens({ title: "x", transport_modes: ["road"], jurisdictions: ["EU"] }, { jurisdictions: { SG: 1 } });
  assert.equal(mismatch.band, "low");
});

test("role signals engage the reader's roles on import/export language only", () => {
  assert.deepEqual(lens({ title: "Customs declaration rules" }).roleSignals, ["freight operator"]);
  assert.deepEqual(lens({ title: "Battery chemistry" }).roleSignals, []);
});

test("applicability: a tag that maps to a role the profile holds applies; one that excludes every held role does not; none held needs input", () => {
  const item = { title: "x", compliance_object_tags: ["carrier-ocean"] };
  assert.equal(lens(item, { orgRoles: ["carrier"] }).applicability?.status, "applies");
  assert.equal(lens(item, { orgRoles: ["shipper"] }).applicability?.status, "does_not_apply");
  const needs = lens(item, { orgRoles: [] }).applicability;
  assert.deepEqual([needs?.status, needs?.missingDimensions], ["needs_profile_input", ["role"]]);
});

test("applicability: a size threshold with no org_size needs input naming the dimension; unmapped tags never block", () => {
  const sized = { title: "x", size_threshold: { dimension: "headcount", band: "large", comparison: "at_least" } };
  assert.deepEqual([lens(sized, { orgSize: {} }).applicability?.status, lens(sized, { orgSize: {} }).applicability?.missingDimensions], ["needs_profile_input", ["headcount"]]);
  assert.equal(lens(sized, { orgSize: { headcount_band: "micro" } }).applicability?.status, "does_not_apply");
  assert.equal(lens(sized, { orgSize: { headcount_band: "large" } }).applicability?.status, "applies");
  assert.equal(lens({ title: "x", compliance_object_tags: ["port-operator"] }, { orgRoles: ["shipper"] }).applicability?.status, "applies");
});

const OBJECTS = [
  { obligation_id: "a", binding_position: "direct_duty", duty_holder_class: ["forwarder"], applicability_trigger: { attribute: "org_role", value: "forwarder" }, statutory_maximum: "EUR 100 per tonne", cost_formula: "tonnes x 100", direct_compliance_cost: { amount: 12, currency: "EUR", basis: "per filing", source: "Annex II" }, effort: { person_days: 3, recurrence: "annual" } },
  { obligation_id: "b", binding_position: "carrier_passthrough", duty_holder_class: ["carrier"], applicability_trigger: { attribute: "headcount", value: "medium", comparison: "below" } },
  { obligation_id: "c", binding_position: "monitoring_only", duty_holder_class: ["port_authority"], applicability_trigger: { attribute: "fleet_size", value: "10" } },
];

test("obligation grain: lines are ordered by binding position, carry duty holders, trigger labels, the three cost slots, and the best applicability per line", () => {
  const out = summariseObligationBinding(OBJECTS, { orgRoles: ["forwarder"], orgSize: { headcount_band: "small", revenue_band: null, shipment_volume_band: null } }, relevanceDeps);
  assert.deepEqual([out.decomposed, out.objectCount, out.lines.map((l) => l.position)], [true, 3, ["direct_duty", "carrier_passthrough", "monitoring_only"]]);
  const [duty, passthrough, monitor] = out.lines;
  assert.deepEqual([duty?.label, duty?.dutyHolders, duty?.triggers[0]?.label, duty?.applicability?.status], ["Your duty", [{ id: "forwarder", label: "Freight forwarder" }], "Your organisation role is Freight forwarder", "applies"]);
  assert.deepEqual(duty?.costSlots.map((s) => [s.slot, s.entries]), [["penalty_exposure", ["EUR 100 per tonne", "Formula: tonnes x 100"]], ["direct_compliance_cost", ["12 EUR, per filing (source: Annex II)"]], ["effort", ["3 person-days, annual"]]]);
  assert.equal(passthrough?.triggers[0]?.label, "Headcount is below Medium (50-249 employees)");
  assert.equal(passthrough?.applicability?.status, "does_not_apply");
  assert.deepEqual([monitor?.applicability?.status, monitor?.applicability?.missingDimensions, monitor?.triggers[0]?.label], ["needs_profile_input", ["fleet_size"], "A condition your profile does not describe"]);
  assert.doesNotMatch(String(monitor?.applicability?.reasons), /fleet_size/, "an attribute id is the schema's word, not the customer's (W:59)");
  assert.equal(out.applicability?.grain, "obligation");
  assert.equal(out.applicability?.status, "applies");
});

test("obligation grain beats the item grain in the lens; no objects is not decomposed", () => {
  const r = lens({ title: "x", compliance_object_tags: ["carrier-ocean"], obligation_objects: [OBJECTS[0]] }, { orgRoles: ["forwarder"] });
  assert.deepEqual([r.binding.decomposed, r.applicability?.status], [true, "applies"]);
  assert.deepEqual(summariseObligationBinding([], {}, relevanceDeps), { decomposed: false, objectCount: 0, applicability: null, lines: [] });
  assert.equal(summariseObligationBinding(undefined, {}, relevanceDeps).decomposed, false);
});

test("dutyHoldersExcludeForwarder is the monitoring_only test; currentObligationObjects drops superseded versions", () => {
  assert.equal(dutyHoldersExcludeForwarder(["carrier", "port_authority"], relevanceDeps.dutyHolderClasses), true);
  assert.equal(dutyHoldersExcludeForwarder(["carrier", "nvocc"], relevanceDeps.dutyHolderClasses), false);
  assert.equal(dutyHoldersExcludeForwarder([], relevanceDeps.dutyHolderClasses), false);
  assert.deepEqual(currentObligationObjects([{ obligation_id: "v1" }, { obligation_id: "v2", supersedes: "v1" }, { obligation_id: "other" }]).map((r) => r.obligation_id), ["v2", "other"]);
  assert.deepEqual(currentObligationObjects(null), []);
});

test("relevanceForItem applies a workspace profile to an item", () => {
  const r = relevanceForItem({ title: "Customs rules", transport_modes: ["air"] }, { ...DEFAULT_WORKSPACE_PROFILE, verticals: [] }, relevanceDeps);
  assert.deepEqual([r.matchedModes, r.roleSignals], [["air"], ["freight operator"]]);
});

test("fetchObligationObjectsForItem: current objects for a uuid or a legacy id; [] for an unknown id; a read error or a cut-off list THROWS", async () => {
  const db = seed();
  db.rows("obligation_objects").push({ obligation_id: "v1", instrument_item_id: ITEM_1 }, { obligation_id: "v2", supersedes: "v1", instrument_item_id: ITEM_1 }, { obligation_id: "z", instrument_item_id: "elsewhere" });
  const client = clientFor(db);
  assert.deepEqual((await fetchObligationObjectsForItem(client, "o3")).map((r) => r.obligation_id), ["v2"]);
  assert.deepEqual((await fetchObligationObjectsForItem(client, ITEM_1)).map((r) => r.obligation_id), ["v2"]);
  assert.deepEqual(await fetchObligationObjectsForItem(client, "nope"), []);
  assert.deepEqual(await fetchObligationObjectsForItem(client, ""), []);
  db.fail("obligation_objects", "select", { message: "down" });
  await assert.rejects(fetchObligationObjectsForItem(client, "o3"), /down/);
  db.failures.length = 0;
  await assert.rejects(fetchObligationObjectsForItem(client, "o3", { limit: 2 }), /bound/);
  db.failures.length = 0;
  db.fail("intelligence_items", "select", { message: "lookup down" });
  await assert.rejects(fetchObligationObjectsForItem(client, "o3"), /lookup down/);
});

// ── roster ───────────────────────────────────────────────────────────────────────────────────────────

test("canWrite and isOrgAdmin: a viewer reads only, owner and admin administer", () => {
  assert.deepEqual(["owner", "admin", "member", "viewer", null].map(canWrite), [true, true, true, false, false]);
  assert.deepEqual(["owner", "admin", "member", "viewer", undefined].map(isOrgAdmin), [true, true, false, false, false]);
});

test("itemIdFromDetailPath reads the id off the four detail routes only", () => {
  assert.equal(itemIdFromDetailPath("/regulations/o3"), "o3");
  assert.equal(itemIdFromDetailPath("/market/some%20id/"), "some id");
  assert.equal(itemIdFromDetailPath("/operations/abc"), "abc");
  assert.equal(itemIdFromDetailPath("/research/abc"), "abc");
  for (const bad of ["/regulations", "/regulations/a/b", "/settings/o3", "/regulations/%E0%A4%A", null, 5]) assert.equal(itemIdFromDetailPath(bad), null);
});

test("loadRoster: the org's members with names, org-scoped and complete past one page; a failed read throws; past the cap it refuses", async () => {
  const db = seed();
  for (let i = 0; i < 1100; i += 1) db.rows("org_memberships").push({ id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, org_id: "other-org", user_id: `u${i}`, role: "member", created_at: "2026-03-01T00:00:00Z" });
  const roster = await loadRoster(clientFor(db), ORG_A);
  assert.deepEqual(roster.map((m) => m.role).sort(), ["admin", "member", "member", "owner", "viewer"]);
  assert.equal(roster.find((m) => m.user_id === USER.admin)?.display_name, "Name admin");
  for (let i = 0; i < 1001; i += 1) db.rows("org_memberships").push({ id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, org_id: ORG_A, user_id: `v${i}`, role: "member", created_at: "2026-04-01T00:00:00Z" });
  await assert.rejects(loadRoster(clientFor(db), ORG_A), /roster/);
  db.fail("org_memberships", "select");
  await assert.rejects(loadRoster(clientFor(db), ORG_A), /lookup failed/);
});

test("orgWatchersOf: one rpc; watchers are scoped by membership, found by uuid or legacy id; the team watchlist is its own bit; a failure is a LookupError", async () => {
  const db = seed();
  for (let i = 0; i < 120; i += 1) db.rows("org_memberships").push({ id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`, org_id: ORG_A, user_id: `m${i}`, role: "member", created_at: "2026-05-01T00:00:00Z" });
  db.rows("user_watchlist").push({ id: "w9", user_id: "m110", item_id: ITEM_1 });
  const client = clientFor(db);
  const first = await orgWatchersOf(client, ORG_A, [ITEM_1, "o3", ITEM_1, ""]);
  assert.deepEqual(first.watcherIds.sort(), [USER.member, "m110"].sort());
  assert.equal(first.onTeamWatchlist, false);
  assert.equal(db.log.filter((l) => l.table === "user_watchlist" || l.table === "org_memberships").length, 0, "no roster or watchlist table is paged: the database answers");
  db.rows("org_watchlist").push({ id: "t1", org_id: ORG_A, item_id: "o3" });
  assert.equal((await orgWatchersOf(client, ORG_A, ["o3"])).onTeamWatchlist, true);
  assert.equal((await orgWatchersOf(client, ORG_B, ["o3"])).onTeamWatchlist, false, "another org's team list is not this org's");
  assert.ok(!(await orgWatchersOf(client, ORG_A, [ITEM_1])).watcherIds.includes(USER.otherOrgMember), "a watcher who belongs to another org is not returned for this one");
  assert.deepEqual(await orgWatchersOf(client, ORG_A, []), { watcherIds: [], onTeamWatchlist: false });
  const down = clientFor(Object.assign(seed(), {}));
  (down as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { message: "rpc down" } });
  await assert.rejects(orgWatchersOf(down, ORG_A, ["o3"]), /org_watchers/);
});
