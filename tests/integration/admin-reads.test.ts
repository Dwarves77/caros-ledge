// P2-14: the console reads what the fixture turn wrote, and an override filed in the console is respected by the turn's own writers. The same world and the same
// wiring as one-turn.test.ts; the admin handlers run over the fixture database as the service client, behind the real guard with a platform-admin session.
import assert from "node:assert/strict";
import { test } from "node:test";

import { writeEffectiveTierUnlessOverridden } from "@/core/sources/tier-writers";
import { runTurn } from "@/core/turn";
import { GET as flagsGet } from "@/features/admin/api/integrity-flags";
import { applyTierOverride } from "@/features/admin/api/source-controls";
import { readDashboard } from "@/features/admin/read/dashboard";
import { POST as corpusPost, GET as corpusGet } from "@/features/admin/api/corpus-turns";

import { scripted } from "../_support/fake-clients.ts";
import type { Row } from "../_support/memdb.ts";
import { as, ctx, personaOf, userDbFor } from "../_support/personas.ts";

import { CENSUS, fixture, NEW_URL, NEW_VERDICT, NOW, SRC } from "./world.ts";

const BATCH = JSON.stringify({ verdicts: [{ census_id: CENSUS, verdict: "on_vertical", basis: "EU emissions regulation: core sustainability scope", reviewer: "turn-test" }] });
const ADMIN = "u-admin";

/** admin_attention_counts over the fixture rows, counted the way the database function counts them (migration 0029). */
function installAttention(f: ReturnType<typeof fixture>) {
  const n = (table: string, pred: (r: Row) => boolean) => f.db.rows(table).filter(pred).length;
  f.db.rpcs.admin_attention_counts = () => {
    const row = {
      provisional_sources_pending: n("provisional_sources", (r) => r.status === "pending_review" || r.status === "needs_more_data"),
      staged_updates_pending: n("staged_updates", (r) => r.status === "pending"),
      staged_updates_materialization_failed: n("staged_updates", (r) => r.status === "approved" && !r.materialized_at && !!r.materialization_error),
      integrity_flags_unresolved: n("intelligence_items", (r) => r.agent_integrity_flag === true && !r.agent_integrity_resolved_at),
      platform_integrity_flags_open: n("integrity_flags", (r) => r.status === "open" || r.status === "in_review"),
      source_attribution_mismatches: 0,
      auto_approved_awaiting_spotcheck: 0,
      coverage_gaps_critical: 0,
      ingest_rejections_untriaged: n("ingest_rejections", (r) => !r.triaged_at),
    };
    return { data: [{ ...row, total: Object.values(row).reduce((a, b) => a + b, 0) }] };
  };
}

function asAdmin(f: ReturnType<typeof fixture>) {
  installAttention(f);
  scripted.user = (request) => userDbFor(personaOf(request)).db;
  scripted.service = () => f.db.client as never;
}

test("the console's reads show what the turn wrote: the platform flags, the registry, and a regeneration request filed in the console", async () => {
  const f = fixture();
  const r = await runTurn({ stage: "all", mode: "apply", input: { intake: { census: { limit: 5 } }, propagate: { producers: { only: "ecb-fx" } }, briefs: { batch: { kind: "screen-verdicts", content: BATCH } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(r.exit, 0);
  asAdmin(f);

  const flags = (await (await flagsGet(as("platformAdmin", "/api/admin/integrity-flags?platform=1"), ctx({}) as never)).json()) as { counts: { total: number } };
  assert.equal(flags.counts.total, f.db.rows("integrity_flags").length, "the console's flag total is the table's, not a separate figure");
  assert.ok(flags.counts.total > 0, "the turn wrote flags and the console shows them");

  const dash = await readDashboard(f.db.client as never, NOW.toISOString());
  assert.ok(dash.sources.ok && dash.sources.data.length === f.db.rows("sources").length, "every registered source is on the console");
  assert.ok(dash.staged.ok && dash.staged.data.total === f.db.rows("staged_updates").filter((x) => x.status === "pending").length, "the staged badge equals the pending rows");

  const item = f.db.rows("intelligence_items").find((x) => x.provenance_status === "verified") as Row;
  const filed = await corpusPost(as("platformAdmin", "/api/admin/corpus-turn-requests", { method: "POST", body: JSON.stringify({ itemId: item.id }) }), ctx({}) as never);
  assert.equal(filed.status, 200);
  const open = (await (await corpusGet(as("platformAdmin", "/api/admin/corpus-turn-requests"), ctx({}) as never)).json()) as { total_open?: number; open?: unknown[]; requests?: unknown[] };
  assert.equal(f.db.rows("corpus_turn_requests").filter((x) => x.intelligence_item_id === item.id).length, 1, "one open request per item");
  assert.ok(JSON.stringify(open).includes(String(item.id)), "the request is on the console");
});

test("the portal path's staged row is visible in the console's transit view as a materialized update, and nothing waits on a person", async () => {
  const f = fixture();
  await runTurn({ stage: "sweep", mode: "apply", input: { intake: { verdicts: { [NEW_URL]: NEW_VERDICT }, maxPromote: 5 } } }, { d: f.d, env: {}, now: () => NOW });
  const staged = f.db.rows("staged_updates").filter((x) => x.status === "approved" && x.materialized_item_id);
  assert.equal(staged.length, 1, "the turn left one approved, materialized staged row");
  installAttention(f);
  const dash = await readDashboard(f.db.client as never, NOW.toISOString());
  assert.ok(dash.attention.ok, "attention counts read");
  assert.ok(dash.staged.ok && dash.staged.data.rows.every((x) => x.status === "pending"), "the pending view carries pending rows only: a materialized row is not a task");
});

test("INV-073 end to end: an override written in the console is respected by the turn's own tier writer; reverting it lets the writer through again", async () => {
  const f = fixture();
  const db = f.db.client as never;
  const before = (f.db.rows("sources").find((x) => x.id === SRC) as Row).effective_tier;
  const done = await applyTierOverride(db, ADMIN, SRC, { tier: 6, reason: "operator knows this publisher" });
  assert.equal(done.action, "set");
  const attack = await writeEffectiveTierUnlessOverridden(db, SRC, 2);
  assert.deepEqual([attack.written, attack.error], [false, null], "the automatic writer matched nothing under an override");
  assert.equal((f.db.rows("sources").find((x) => x.id === SRC) as Row).effective_tier, before, "the effective tier did not move");
  assert.equal((f.db.rows("sources").find((x) => x.id === SRC) as Row).tier_override, 6);
  assert.ok(f.db.rows("source_trust_events").some((e) => e.source_id === SRC && e.event_type === "tier_override" && e.created_by === "human" && e.reviewer_id === ADMIN), "the override has its audit row naming the actor");
  await applyTierOverride(db, ADMIN, SRC, { tier: null, reason: null });
  const after = await writeEffectiveTierUnlessOverridden(db, SRC, 2);
  assert.equal(after.written, true, "with the override reverted the writer is let through");
});
