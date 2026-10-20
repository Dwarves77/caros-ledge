import assert from "node:assert/strict";
import { test } from "node:test";

import { GET as detailGet } from "@/features/workspace/api/portfolio-detail";
import { wireWorkspaceDeps } from "@/features/workspace/api/deps";
import { readPortfolioDetail } from "@/features/workspace/portfolio/read";
import { portfolioDeps } from "@/features/portfolio/deps";
import { readHeld } from "@/features/portfolio/read/held";
import { createPortfolioRequest } from "@/features/portfolio/client";

import { activeItems } from "../_support/workspace-reads.ts";
import type { MemDb, Row } from "../workspace/_memdb.ts";
import { call, clientFor, ITEM_1, ITEM_2, ITEM_ARCHIVED, ORG_A, script, seed } from "../workspace/_world.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const PF = "77777777-0000-4000-8000-000000000001";
const ITEM_OVERRIDDEN = "aaaaaaaa-0000-4000-8000-000000000004";
const SRC = "a1000000-0000-4000-8000-000000000001";

function world(): MemDb {
  const db = script(seed());
  // the database function (migration 0095) over this world: the workspace's own rows for the named ids
  db.scriptRpc("get_workspace_items_by_ids", (a) => activeItems(db as never, String(a.p_org_id)).filter((i) => (a.p_ids as string[]).includes(String(i.id)) && (i.replaced_by ?? null) === null));
  db.rows("sources").push({ id: SRC, name: "EUR-Lex", base_tier: 1, tier_override: null, effective_tier: null });
  for (const i of db.rows("intelligence_items")) Object.assign(i, { source_id: SRC, added_date: "2026-01-01", jurisdictions: ["EU"], transport_modes: ["ocean"], summary: "", domain: 1, item_type: "regulation" });
  db.rows("intelligence_items")[0]!.compliance_deadline = "2026-11-01";
  db.rows("intelligence_items").push({ id: ITEM_OVERRIDDEN, legacy_id: "o5", title: "Archived by this workspace", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, priority: "HIGH", origin_class: "official", source_id: SRC, added_date: "2026-01-01" });
  db.rows("workspace_item_overrides").push({ org_id: ORG_A, item_id: ITEM_OVERRIDDEN, priority_override: null, is_archived: true });
  db.rows("portfolios").push({ id: PF, org_id: ORG_A, name: "Core book", name_key: "core book", created_at: "2026-10-01T00:00:00Z" });
  db.rows("entities").push({ entity_id: "cl:corridor:cnsha-nlrtm", kind: "corridor", status: "active", merged_into: null, canonical_name: "CNSHA-NLRTM:ocean", display_name: null });
  db.rows("portfolio_members").push(
    ...[ITEM_1, ITEM_2, ITEM_ARCHIVED, ITEM_OVERRIDDEN].map((id, i) => ({ id: `m${i}`, portfolio_id: PF, org_id: ORG_A, member_kind: "item", item_id: id, entity_id: null })),
    { id: "me", portfolio_id: PF, org_id: ORG_A, member_kind: "corridor", item_id: null, entity_id: "cl:corridor:cnsha-nlrtm" },
  );
  return db;
}
const client = (db: MemDb) => clientFor(db, "member");

test("held means verified, not archived by the platform and not archived by THIS workspace; everything else stays a member, counted and named, and out of every figure", async () => {
  const db = world();
  const view = await readPortfolioDetail(client(db), ORG_A, PF, NOW, portfolioDeps(client(db)));
  assert.ok(view);
  assert.deepEqual([view.rollup.total, view.rollup.items.members, view.rollup.items.held], [5, 4, 2]);
  assert.deepEqual(view.rollup.items.notHeld.sort(), [ITEM_ARCHIVED, ITEM_OVERRIDDEN].sort(), "the platform-archived and the workspace-archived members are named, not counted");
  assert.deepEqual(view.groups.flatMap((g) => g.rows.map((r) => r.uiId)).sort(), ["o3", "o4"]);
  const fuel = view.groups.flatMap((g) => g.rows).find((r) => r.uiId === "o3");
  assert.equal((fuel?.fields as { href: string }).href, "/regulations/o3", "a member row carries the same list-row fields the lists draw");
  assert.equal((fuel?.fields as { tier: number }).tier, 1, "with its source's rating");
  assert.equal(fuel?.dueDays, 17);
  assert.deepEqual(view.rollup.nextDue, { itemId: ITEM_1, days: 17 });
  assert.deepEqual(view.entityRows.map((e) => e.label), ["Shanghai (CN) → Rotterdam (NL), ocean"], "a corridor reads as A to B");
  assert.equal(view.rollup.origin.weakest, "official");
});

test("B-0280: a failed held read rejects the detail; it never makes a workspace-archived member look held (the override is the database's, in get_workspace_items_by_ids)", async () => {
  const down = (): never => {
    throw new Error("down");
  };
  const db = world();
  db.scriptRpc("get_workspace_items_by_ids", down);
  await assert.rejects(readPortfolioDetail(client(db), ORG_A, PF, NOW, portfolioDeps(client(db))), /get_workspace_items_by_ids failed: down/);
  const items = world();
  items.scriptRpc("get_workspace_items_by_ids", down);
  await assert.rejects(readHeld(client(items), ORG_A, [ITEM_1], NOW), /get_workspace_items_by_ids failed: down/);
});

test("the detail API answers with the real held layer wired, for a member and not for another workspace", async () => {
  const db = world();
  wireWorkspaceDeps({ portfolio: portfolioDeps(client(db)) });
  const ok = await call(detailGet, "member", "GET", `/api/workspace/portfolios/${PF}`, undefined, { id: PF });
  assert.equal(ok.status, 200);
  assert.equal(((ok.body.rollup as Row).items as Row).held, 2);
  assert.equal((await call(detailGet, "otherOrgMember", "GET", `/api/workspace/portfolios/${PF}`, undefined, { id: PF })).status, 404);
});

test("corridorLabel: a canonical corridor name reads as A to B; anything else is null (the caller falls back to the entity's own name)", () => {
  const { corridorLabel } = portfolioDeps({} as never);
  assert.equal(corridorLabel("CNSHA-NLRTM:ocean"), "Shanghai (CN) → Rotterdam (NL), ocean");
  assert.equal(corridorLabel("corridor:nlrtm:sgsin"), null);
  assert.equal(corridorLabel(""), null);
});

test("the browser calls never throw: no session is a stated sign-in message and no network call is made", async () => {
  const real = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => (hits += 1, new Response("{}"))) as never;
  try {
    const r = await createPortfolioRequest("Core book");
    assert.deepEqual([r.ok, r.status, r.error], [false, 401, "Sign in again to continue."]);
    assert.equal(hits, 0);
  } finally {
    globalThis.fetch = real;
  }
});
