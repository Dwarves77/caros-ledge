import assert from "node:assert/strict";
import { test } from "node:test";

import { GET } from "@/features/market/api/notices";

import { scripted } from "../_support/fake-clients.ts";
import { MemDb, type Row } from "../_support/memdb.ts";
import { as, ctx, PERSONAS, userDbFor, type Persona } from "../_support/personas.ts";

/** The window every case reads: the recompute pair is dated 2026-10-14, and the feed is asked for it explicitly so the clock never decides a case. */
const SINCE = "2026-10-01T00:00:00Z";
const DAY = 86_400_000;
const ITEM = "70869a22-39eb-4eb7-ba49-d3826b5b2265";
const ENTITY = "cl:corridor:9170a8b2fb3234ba";
const dv = (id: string, over: Row = {}): Row => ({ value_id: id, entity_id: ENTITY, method_id: "market_series_delta", method_version: "1.0.0", value: 1, value_low: null, value_high: null, unit: "USD", currency: null, derivation: "calculated", origin_class: "derived", lifecycle: "verified", admissibility: "calculation_ok", base_confidence: 0.9, asserted_at: "2026-10-10T00:00:00Z", half_life_days: null, inputs: [], supersedes: null, computed_at: "2026-10-12T00:00:00Z", computed_by: "t", invalidated_at: null, invalidated_by_event: null, ...over });

/** The caller's own client: membership, the watchlist and, since migration 0036, the derived values and the corpus events view. No service client is configured: a member page needs none. */
function seedWorld(o: { failValues?: boolean; entity?: Row | null } = {}) {
  const user = new MemDb({}, {
    org_watchlist: [{ id: "w1", org_id: "11111111-1111-4111-8111-111111111111", item_type: "signal", item_id: ITEM }, { id: "w2", org_id: "22222222-2222-4222-8222-222222222222", item_type: "signal", item_id: "other-org-item" }],
    intelligence_items: [{ id: ITEM, title: "Diesel", domain: 4, instrument_entity_id: ENTITY, provenance_status: "verified", replaced_by: null }],
  });
  user.seed("derived_values", [dv("old", { invalidated_by_event: 7, admissibility: "stale", value: 1 }), dv("new", { supersedes: "old", value: 2, computed_at: "2026-10-14T00:00:00Z" })]);
  if (o.entity !== null) user.seed("entities", [{ entity_id: ENTITY, canonical_name: "CNSHA-NLRTM:ocean", kind: "corridor", status: "active", display_name: null, ...(o.entity ?? {}) }]);
  user.views.recalculation_events = () => [{ event_id: 7, occurred_at: "2026-10-13T00:00:00Z", table_name: "market_series", row_pk: "r1", change_kind: "update" }];
  if (o.failValues) user.fail("derived_values", "select", "derived down");
  scripted.user = (request) => {
    const base = userDbFor((request?.headers.get("authorization")?.replace("Bearer ", "") ?? "anon") as Persona).db as unknown as { from: (t: string) => unknown; auth: unknown; rpc: unknown };
    const own = new Set(["org_memberships", "profiles", "workspace_settings", "organizations"]);
    return { auth: base.auth, rpc: base.rpc, from: (t: string) => (own.has(t) ? base.from(t) : user.from(t)) };
  };
  scripted.service = null;
  return { user };
}
const call = (p: Persona, url = `/api/notices?since=${SINCE}`) => GET(as(p, url), ctx({}) as never);

test("?since=: a valid instant stands, a malformed one degrades to the default 30-day window and never a 400", async () => {
  seedWorld();
  const since = async (q: string) => ((await (await call("member", `/api/notices${q}`)).json()) as { since: string }).since;
  assert.equal(await since("?since=2026-10-01T00:00:00Z"), "2026-10-01T00:00:00.000Z");
  const before = Date.now();
  const bad = Date.parse(await since("?since=not%20a%20date"));
  assert.ok(Math.abs(before - 30 * DAY - bad) < 60_000, "a malformed instant is the default window before now");
  assert.ok(Math.abs(Date.parse(await since("")) - bad) < 60_000, "an absent one is the same window");
  assert.equal((await call("member", "/api/notices?since=not%20a%20date")).status, 200);
});

test("the notice carries its entity's label: the display name, else the corridor label its name spells, else the name; an unknown entity has none", async () => {
  const labelOf = async (entity: Row | null) => {
    seedWorld({ entity });
    const body = (await (await call("member")).json()) as { notices: Array<{ entityLabel: string | null }> };
    return body.notices.map((n) => n.entityLabel);
  };
  assert.deepEqual(await labelOf({ canonical_name: "CNSHA-NLRTM:ocean", display_name: null }), ["Shanghai (CN) → Rotterdam (NL), ocean"]);
  assert.deepEqual(await labelOf({ canonical_name: "CNSHA-NLRTM:ocean", display_name: "Asia to Europe" }), ["Asia to Europe"]);
  assert.deepEqual(await labelOf({ canonical_name: "plain name", display_name: null }), ["plain name"]);
  assert.deepEqual(await labelOf(null), [null], "an entity the spine does not hold has no label");
});

test("the feed is about the entities the org's watched rows are about: an item's instrument entity and its entity refs, a source's organisation, a market series none", async () => {
  const { user } = seedWorld();
  const REF = "cl:jurisdiction:aaaaaaaaaaaaaaaa";
  const ORGN = "cl:organisation:bbbbbbbbbbbbbbbb";
  const OTHER = "cl:organisation:cccccccccccccccc";
  user.seed("org_watchlist", [{ id: "w3", org_id: "11111111-1111-4111-8111-111111111111", item_type: "source", item_id: "s1" }, { id: "w4", org_id: "11111111-1111-4111-8111-111111111111", item_type: "market_series", item_id: "m1" }]);
  user.seed("entity_refs", [{ ref_table: "intelligence_items", ref_id: ITEM, entity_id: REF, role: "jurisdiction", asserted_by: "t", asserted_at: "2026-10-01T00:00:00Z" }]);
  user.seed("sources", [{ id: "s1", name: "S", url: "https://a.example.org/", base_tier: 3, organisation_entity_id: ORGN }]);
  user.seed("entities", [REF, ORGN, OTHER].map((id) => ({ entity_id: id, canonical_name: id, kind: "organisation", status: "active", display_name: null })));
  user.seed("derived_values", [REF, ORGN, OTHER].flatMap((e, i) => [dv(`old${i}`, { entity_id: e, value: 1 }), dv(`new${i}`, { entity_id: e, supersedes: `old${i}`, value: 2, computed_at: "2026-10-14T00:00:00Z" })]));
  const body = (await (await call("member")).json()) as { notices: Array<{ entityId: string }> };
  assert.deepEqual(body.notices.map((n) => n.entityId).sort(), [ENTITY, ORGN, REF].sort(), "the unwatched entity has no notice, the market series adds none");
  user.fail("entity_refs", "select", "refs down");
  assert.equal((await call("member")).status, 503);
});

test("persona matrix: every signed-in caller is answered, anon is refused; a member of another org sees only their own watchlist's notices", async () => {
  seedWorld();
  for (const p of PERSONAS) {
    const res = await call(p);
    assert.equal(res.status, p === "anon" ? 401 : 200, `as ${p}`);
  }
  const member = (await (await call("member")).json()) as { notices: Array<{ entityLabel: string; oldValue: number; newValue: number }>; since: string };
  assert.deepEqual(member.notices.map((n) => [n.entityLabel, n.oldValue, n.newValue]), [["Shanghai (CN) → Rotterdam (NL), ocean", 1, 2]], "the pair the recompute superseded, labelled");
  assert.equal(member.since, "2026-10-01T00:00:00.000Z");
  const other = (await (await call("otherOrgMember")).json()) as { notices: unknown[] };
  assert.deepEqual(other.notices, [], "org B watches an item that resolves to no entity with a recomputed value");
  const admin = (await (await call("platformAdmin")).json()) as { notices: unknown[] };
  assert.deepEqual(admin.notices, [], "no organisation, no team watchlist: the honest empty");
});

test("INV-263 a failed read is a 503 with Retry-After, never an empty 200; a deployment with no service key still answers a member (0036)", async () => {
  seedWorld({ failValues: true });
  const down = await call("member");
  assert.equal(down.status, 503);
  assert.ok(down.headers.get("retry-after"));
  seedWorld();
  assert.equal((await call("member")).status, 200, "no service key: the member's own client answers");
  const { user } = seedWorld();
  user.fail("org_watchlist", "select", "watchlist down");
  assert.equal((await call("member")).status, 503);
});
