// ONE system, not independent systems (operator, 2026-10-16). The whole chain runs on the shared fixture database through the real wiring: a registered source is swept, its change detected, its page captured,
// the capture minted through intake and the mint chokepoint, the mint connected, a producer run and its edges authored, the outbox drained over the events, and a session batch applied through the briefs stage.
// ONE root_run_id across every ledger row. Each stage's outputs are asserted as the next stage's inputs BY ID, then the surface readers that exist are called and must return what the turn wrote.
// A surface slice (P2-10 onward) extends this file with its reader; it never proves its page from rows it seeds itself.
import assert from "node:assert/strict";
import { test } from "node:test";

import { chainProof, flywheelOutcomes, mintedIds } from "@/core/harness";
import { runTurn } from "@/core/turn";
import { loadCoverage } from "@/features/coverage/server/census";
import { loadDetail } from "@/core/detail";
import { buildRegisterQuerySpec, fetchObligationRegisterPage, readUpcoming } from "@/features/obligations";
import { readDerivedFigures } from "@/features/operations/read/operations-reads";
import { readResearchPage } from "@/features/research/read/research-reads";
import { readRegulationsFirstPage } from "@/features/regulations/list-read";

import type { Row } from "../_support/memdb.ts";

import { CENSUS, DOC, DOC_TEXT, DOC_URL, fixture, NEW_URL, NEW_VERDICT, NOW, PORTAL_URL, RESEARCH_URL, RESEARCH_VERDICT, SRC } from "./world.ts";

const BATCH = JSON.stringify({ verdicts: [{ census_id: CENSUS, verdict: "on_vertical", basis: "EU emissions regulation: core sustainability scope", reviewer: "turn-test" }] });

async function theTurn() {
  const f = fixture();
  const r = await runTurn({ stage: "all", mode: "apply", input: { intake: { census: { limit: 5 } }, propagate: { producers: { only: "ecb-fx" } }, briefs: { batch: { kind: "screen-verdicts", content: BATCH } } } }, { d: f.d, env: {}, now: () => NOW });
  const ledger = f.db.rows("harness_runs");
  const by = (family: string) => ledger.find((x) => x.family === family) as Row;
  const ids = (family: string): Record<string, string[]> => ((by(family).outputs as { ids?: Record<string, string[]> }).ids ?? {});
  const counts = (family: string): Record<string, number> => ((by(family).outputs as { counts?: Record<string, number> }).counts ?? {});
  return { ...f, r, ledger, by, ids, counts };
}

test("the whole turn: every stage records under ONE root, each the next one's upstream, and every hand-off is by id", async () => {
  const t = await theTurn();
  const { r, db, ledger, by, ids, counts } = t;
  assert.equal(r.exit, 0);
  assert.deepEqual(r.plan, ["sweep", "sweep-research", "change", "capture", "intake", "connect", "propagate", "briefs"]);
  assert.equal(r.resolved.mode, "apply", "the cadence is on in this fixture and the run is an operator dispatch");

  // One root; one row per stage family; the head's id is the root; each stage's upstream is the previous stage's row.
  assert.equal(new Set(ledger.map((x) => x.root_run_id)).size, 1);
  assert.equal(ledger.find((x) => x.family === "source-sweep")?.id, r.rootRunId);
  const stages = ["source-sweep", "research-walker", "change-detection", "fetch-drain", "ledger-consume", "corpus-turn", "propagation", "brief-apply"];
  for (const f of stages) assert.equal(ledger.filter((x) => x.family === f).length, 1, `${f}: exactly one row`);
  stages.slice(1).forEach((f, i) => assert.equal(by(f).upstream_run_id, by(stages[i] as string).id, `${f} follows ${stages[i]}`));
  assert.deepEqual([...new Set(ledger.map((x) => x.family))].filter((f) => !stages.includes(String(f))).sort(), ["mint", "producers"], "the only other rows are the runtimes' own unit rows");
  assert.deepEqual(stages.map((f) => by(f).outcome), ["success", "refused", "success", "success", "success", "success", "success", "success"], "the research walker is held by its reviewed constant: a recorded refusal that does not stop the turn");
  assert.match(String(by("research-walker").reason), /ENABLED constant is false/);

  // sweep -> change: the swept sources are the sources the change stage checked; the walked feed landed its link in the portal ledger.
  assert.deepEqual(ids("source-sweep").swept_source_ids?.sort(), [SRC, DOC].sort());
  const candidate = db.rows("portal_link_candidates").find((x) => x.url === NEW_URL);
  assert.equal(candidate?.source_id, SRC);
  assert.deepEqual(ids("change-detection").changed_source_ids?.sort(), [SRC, DOC].sort());
  assert.equal(db.rows("monitoring_queue").filter((x) => x.change_detected === true).length, 2);

  // change -> capture: each changed source was queued, drained, and stored whole as a capture with its id handed on.
  const captureIds = ids("fetch-drain").capture_ids ?? [];
  assert.equal(captureIds.length, 2);
  const captured = db.rows("agent_run_searches").filter((x) => captureIds.includes(String(x.id)));
  assert.deepEqual(captured.map((x) => x.result_url).sort(), [DOC_URL, PORTAL_URL].sort());
  assert.equal(captured.find((x) => x.result_url === DOC_URL)?.result_content, DOC_TEXT, "the stored capture is the whole fetched document");
  assert.ok(db.rows("pending_first_fetch").every((x) => x.status === "done"));

  // capture -> intake: the mint read THAT capture (by its URL), minted one item, stamped the census row, and the portal candidate with no verdict was owed, never fetched or sent anywhere.
  const minted = ids("ledger-consume").minted_item_ids ?? [];
  assert.equal(minted.length, 1);
  const item = db.rows("intelligence_items").find((x) => x.id === minted[0]) as Row;
  assert.deepEqual([item.provenance_status, item.item_grade, item.source_id, item.source_url], ["verified", "record", SRC, DOC_URL]);
  assert.equal(db.rows("census_worklist").find((x) => x.id === CENSUS)?.enumeration_status, "reconciled");
  const pool = db.rows("agent_run_searches").filter((x) => x.intelligence_item_id === item.id);
  assert.ok(pool.length >= 1 && pool.every((x) => x.result_content === DOC_TEXT && x.result_url === DOC_URL), "the item's pool row IS the stored capture");
  const facts = db.rows("section_claim_provenance").filter((x) => x.intelligence_item_id === item.id && x.claim_kind === "FACT");
  assert.ok(facts.length > 0 && facts.every((x) => pool.some((p) => p.id === x.search_result_id) && DOC_TEXT.toLowerCase().includes(String(x.source_span).toLowerCase())), "every FACT span is verbatim in the capture it cites");
  assert.deepEqual([counts("ledger-consume").verdicts_owed, counts("ledger-consume").promoted], [1, 0]);
  assert.equal(candidate?.status, "candidate", "an unclassified candidate stays a candidate");
  assert.ok(!t.requests.urls.includes(NEW_URL), "no fetch was spent on a candidate nothing can classify");
  const mintRow = ledger.find((x) => x.family === "mint") as Row;
  assert.deepEqual([(mintRow.inputs as { item_id?: string }).item_id, mintRow.upstream_run_id, mintRow.root_run_id], [item.id, by("fetch-drain").id, r.rootRunId]);

  // intake -> connect: the minted id IS the connected id, and the flywheel left its marks on that item.
  assert.deepEqual(ids("corpus-turn").connected_item_ids, minted);
  assert.ok(counts("corpus-turn").tag_items_written >= 1 && counts("corpus-turn").term_writes >= 1);
  const events = db.rows("item_forward_events").filter((x) => x.intelligence_item_id === item.id);
  assert.deepEqual(events.map((x) => [x.event_kind, x.event_date]), [["entry_into_force", "2027-01-01"]]);
  const obligation = db.rows("obligations").find((x) => x.intelligence_item_id === item.id) as Row;
  assert.equal(obligation.forward_event_id, events[0]?.id, "the obligation derives from that event");
  assert.ok(db.rows("entity_refs").some((x) => x.ref_id === item.id && x.role === "jurisdiction"));

  // connect -> propagate: the producer wrote its row and authored its edges in the same run; the event the write emitted is the event the drain processed; the derived value was recomputed and superseded.
  const point = db.rows("market_series").find((x) => x.reference_period === "2026-10-15") as Row;
  assert.ok(point, "the producer inserted today's point");
  const drained = db.rows("propagation_events");
  assert.deepEqual(drained.map((e) => [e.row_pk, e.drained_at !== null]), [[point.id, true]]);
  assert.deepEqual(ids("propagation").drained_event_ids, drained.map((e) => String(e.event_id)));
  const dv = db.rows("derived_values");
  const stale = dv.find((v) => v.admissibility === "stale") as Row;
  const current = dv.find((v) => v.supersedes === stale.value_id) as Row;
  assert.equal(stale.invalidated_by_event, drained[0]?.event_id, "the stale row names the event that staled it");
  assert.ok(Math.abs(Number(current.value) - 0.05) < 1e-9 && current.method_id === "market_series_delta", "the derived value the surface reads is the recomputed delta");
  assert.ok((stale.inputs as { pk: string }[]).some((i) => i.pk === point.id), "its inputs name the point the producer wrote");
  const producerRow = ledger.find((x) => x.family === "producers") as Row;
  assert.deepEqual([producerRow.upstream_run_id, (producerRow.outputs as { counts: Record<string, number> }).counts.edges_authored], [by("corpus-turn").id, 1]);
  assert.deepEqual([counts("propagation").drained, counts("propagation").recomputed], [1, 1]);

  // propagate -> briefs: the session batch was validated and written once.
  assert.equal(counts("brief-apply").applied, 1);
  assert.deepEqual(db.rows("screen_verdicts").map((x) => [x.census_id, x.verdict, x.reviewer]), [[CENSUS, "on_vertical", "turn-test"]]);

  // The ledger proofs, read from the ledger alone.
  const chain = await chainProof(db.client, r.rootRunId);
  assert.deepEqual([chain.ok, chain.missing, chain.failed], [true, [], []]);
  assert.deepEqual(chain.held, ["research-walker:refused"]);
  assert.deepEqual(await mintedIds(db.client), minted, "P2: the minted ids");
  const fly = await flywheelOutcomes(db.client, [r.rootRunId]);
  assert.deepEqual(fly.map((x) => x.family).sort(), ["corpus-turn", "propagation"], "P3: the flywheel families have non-zero outputs under the minted run's root");
});

test("the surface readers that exist return what the turn wrote: the obligation register, the upcoming events, the coverage index", async () => {
  const t = await theTurn();
  const { db, ids } = t;
  const item = (ids("ledger-consume").minted_item_ids ?? [])[0];
  const register = await fetchObligationRegisterPage(db.client, buildRegisterQuerySpec({}, "2026-10-15"));
  assert.equal(register.total, 1);
  assert.deepEqual(register.rows.map((x) => [x.intelligence_item_id, x.due_date]), [[item, "2027-01-01"]]);
  const upcoming = await readUpcoming(db.client, { itemId: item as string }, "2026-10-15");
  assert.deepEqual(upcoming.events.map((e) => [e.intelligence_item_id, e.event_kind, e.event_date]), [[item, "entry_into_force", "2027-01-01"]]);
  const coverage = await loadCoverage(db.client);
  assert.deepEqual([coverage.counts.total, coverage.counts.verifiedBriefs], [1, 1], "the census row and the verified brief the turn minted");
  assert.equal(coverage.entries[0]?.id, CENSUS);
});

test("the portal path: the sweep lands a link, a session verdict classifies it, the intake stage captures it through the free ladder and mints it through the same chokepoint, and the ledger candidate is stamped with the item", async () => {
  const f = fixture();
  const r = await runTurn({ stage: "sweep", mode: "apply", input: { intake: { verdicts: { [NEW_URL]: NEW_VERDICT }, maxPromote: 5 } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(r.exit, 0);
  const minted = ((f.db.rows("harness_runs").find((x) => x.family === "ledger-consume")?.outputs as { ids: { minted_item_ids: string[] } }).ids.minted_item_ids);
  assert.equal(minted.length, 1);
  const item = f.db.rows("intelligence_items").find((x) => x.id === minted[0]) as Row;
  assert.deepEqual([item.source_url, item.item_grade, item.item_type], [NEW_URL, "record", "regulation"]);
  const candidate = f.db.rows("portal_link_candidates").find((x) => x.url === NEW_URL) as Row;
  assert.deepEqual([candidate.status, candidate.item_id], ["promoted", item.id]);
  assert.ok(f.requests.urls.includes(NEW_URL), "the page was fetched, once the verdict existed");
  assert.equal(f.db.rows("staged_updates").filter((x) => x.materialized_item_id === item.id && x.status === "approved").length, 1, "it passed the staged transit and the chokepoint, not a side door");
  assert.ok(f.db.rows("agent_run_searches").some((x) => x.intelligence_item_id === item.id && x.result_url === NEW_URL && String(x.result_content).includes("shall enter into force on 1 July 2026")), "its pool row is the captured page");
});

// P4 (P2-12): the Operations panel and the Research list render what the turn produced. The derived value the propagation stage recomputed shows with its previous value, its inputs and a rating; the research finding the
// intake stage minted shows on the Research list with the assessment the producer wrote for it, anchored on the dated statutory event and a maturity corridor read from the text.
test("P4: the derived value the turn propagated reads on the Operations panel with provenance, and the research assessment the turn produced reads on the Research list", async () => {
  const f = fixture({ research: true });
  // The page's list rpc, answered from the minted rows (the database function projects the same columns); a range-able reply like the real client's.
  const listRows = (): unknown[] => f.db.rows("intelligence_items").filter((x) => x.item_type === "research_finding").map((x) => ({ id: x.id, legacy_id: x.legacy_id ?? null, title: x.title, item_type: x.item_type, domain: x.domain, priority: x.priority, added_date: String(x.added_date ?? NOW.toISOString()).slice(0, 10), is_archived: false, effective_archived: false }));
  const answers: Record<string, () => unknown> = { get_research_items_public: listRows, get_surface_counts: () => ({ total_items: 1 }), get_research_source_coverage: () => [] };
  const base = f.db.client as unknown as { rpc: (n: string, a?: Record<string, unknown>) => unknown };
  const client = new Proxy(f.db.client as object, { get: (t, k) => (k === "rpc" ? (n: string, a?: Record<string, unknown>) => { const hit = answers[n]; if (!hit) return base.rpc(n, a); const run = Promise.resolve({ data: hit(), error: null }); return Object.assign(run, { range: () => run }); } : Reflect.get(t, k)) }) as typeof f.db.client;
  const r = await runTurn({ stage: "all", mode: "apply", input: { intake: { census: { limit: 5 }, verdicts: { [RESEARCH_URL]: RESEARCH_VERDICT }, maxPromote: 5 }, propagate: { producers: { only: "ecb-fx" } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(r.exit, 0);

  const figures = await readDerivedFigures(f.db.client);
  const delta = figures.find((x) => x.title.includes("EUR"));
  assert.ok(delta, "the propagated figure reads on the panel");
  assert.ok(Math.abs(Number(delta.value) - 0.05) < 1e-9 && delta.previous !== null && delta.inputs.length >= 1);
  assert.ok(!JSON.stringify(figures).includes("market_series_delta"), "no internal method name reaches the surface");

  const finding = f.db.rows("intelligence_items").find((x) => x.item_type === "research_finding") as Row;
  assert.ok(finding, "the research finding was minted through the chokepoint");
  // A portal-promoted item is minted unverified (its grounding is a later pass); the assessment producer takes verified items only. The validator's stamp is the one stand-in here: the item is stamped and the database trigger's
  // event is emitted, then the next propagate stage drains it and the producer scores the item from its captured text and its forward events.
  assert.equal(finding.provenance_status ?? null, null, "the promoted item starts unverified, so it is not assessed on the turn that minted it");
  finding.provenance_status = "verified";
  f.db.rows("propagation_events").push({ event_id: 9001, occurred_at: NOW.toISOString(), table_name: "intelligence_items", row_pk: finding.id, entity_id: null, change_kind: "update", new_row: { ...finding }, drained_at: null });
  const second = await runTurn({ stage: "propagate", mode: "apply", input: {} }, { d: f.d, env: {}, now: () => NOW });
  assert.equal(second.exit, 0);
  const page = await readResearchPage(client, "org-1");
  assert.deepEqual([page.rowsFailed, page.rows.length], [false, 1]);
  const view = page.assessments?.[String(finding.id)] ?? page.assessments?.[String(finding.legacy_id)];
  assert.ok(view, "the assessment the producer wrote is the one the list reads");
  assert.deepEqual([view.technical?.low, view.technical?.high], [6, 7], "the corridor is read from the text the turn captured: a demonstration plant is TRL 6-7, not 8-9");
  assert.ok(view.horizon && view.horizon.rule, "the horizon cascade ran");
  assert.equal(f.db.rows("item_forward_events").some((x) => x.intelligence_item_id === finding.id), false, "a portal-promoted item has no forward events yet, so the cascade falls through to its inferred rule rather than anchoring on a date it does not hold");
});

test("P2-10: the item the turn minted and verified renders on /regulations and on its detail, with every section it has, the capture's source rating, and its claims rated by their source", async () => {
  const t = await theTurn();
  const { db, ids } = t;
  const itemId = (ids("ledger-consume").minted_item_ids ?? [])[0] as string;
  const item = db.rows("intelligence_items").find((x) => x.id === itemId) as Row;
  // The two database objects the member reads add (migration 0031): the suppression view, and the listing RPC that returns the items the reader may open.
  db.views.fact_suppressions = () => db.rows("item_corrections").filter((c) => c.target_kind === "fact" && c.item_id === itemId);
  const rpc = db.rpc.bind(db);
  (db as unknown as { rpc: unknown }).rpc = (name: string, args: Record<string, unknown>) => Object.assign(rpc(name, args), { range: () => rpc(name, args) });
  db.rpcs.get_workspace_intelligence_listings_public = () => ({ data: db.rows("intelligence_items").filter((x) => x.provenance_status === "verified" && x.is_archived !== true) });

  // The list: the minted item is a row of the Regulations list, carrying its uuid.
  const list = await readRegulationsFirstPage(db.client, null);
  assert.equal(list.failed, false);
  assert.ok(list.rows.some((r) => r.uuid === itemId), "the minted item is on the Regulations list");

  // The detail: found by its uuid (or legacy id), every stored section carried once, the claims rated by their source, the item's source rated by the registry.
  const detail = await loadDetail("regulations", String(item.legacy_id ?? itemId), undefined, db.client);
  assert.ok(!detail.notFound, "the minted item has a detail page");
  if (detail.notFound) return;
  const stored = db.rows("intelligence_item_sections").filter((x) => x.item_id === itemId);
  assert.deepEqual(detail.sections.map((x) => x.id).sort(), stored.map((x) => String(x.id)).sort(), "every stored section reaches the page, once");
  const facts = db.rows("section_claim_provenance").filter((x) => x.intelligence_item_id === itemId && x.claim_kind === "FACT");
  assert.ok(facts.length > 0 && facts.every((f) => detail.claimTiers[String(f.claim_text)]?.tier === 1), "each FACT claim carries its source's rating: COALESCE(override, base) of the registered source (base tier 1)");
  assert.equal(detail.resource.sourceTier ?? null, 1, "the capture's source rating is the registry's, drawn on the item");
  assert.deepEqual(await loadDetail("market", itemId, undefined, db.client), { notFound: true }, "the same item is not found on another surface");
});
