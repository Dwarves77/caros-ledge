// Obligations: the binding-position classifier's fixed order, the register derivation (twice is idempotent), the earliest-future deadline that is never
// nulled, the register read (total equals the count under the same filters, next-due order), and the persona matrix for the two routes with a 503 on a failed read.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConnectDeps } from "@/features/intake";
import { createConnectDeps } from "@/features/flywheel";
import { classifyItemBindingPosition, contextFromClaims, deriveRegister, selectObligationRailRows, syncComplianceDeadline } from "@/features/obligations";
import { GET as registerGet } from "@/features/obligations/api/register";
import { GET as upcomingGet } from "@/features/obligations/api/upcoming";
import { buildRegisterQuerySpec, fetchObligationRegisterPage } from "@/features/obligations/read/register-read";

import { scripted } from "../_support/fake-clients.ts";
import { as, ctx, PERSONAS, userDbFor, type Persona } from "../_support/personas.ts";

import { connectDb } from "./world.ts";

type Row = Record<string, unknown>;
const TODAY = "2026-10-15";

test("binding position: identity first, then the record-facts claim, then the title, then a duty-holder that excludes the forwarder, else null", () => {
  assert.equal(classifyItemBindingPosition({ title: "Anything", instrument_identifier: "Regulation (EU) 2026/1030" })?.source, "instrument_identity");
  assert.equal(classifyItemBindingPosition({ title: "Anything", instrument_identifier: "Regulation (EU) 2026/1030" }, { recordFactsPosition: "monitoring_only" })?.position, "direct_duty", "identity beats the claim");
  const claim = classifyItemBindingPosition({ title: "A plain notice" }, { recordFactsPosition: "customer_contract" });
  assert.deepEqual([claim?.position, claim?.source], ["customer_contract", "record_facts"]);
  assert.deepEqual([classifyItemBindingPosition({ title: "FuelEU Maritime guidance" })?.position, classifyItemBindingPosition({ title: "FuelEU Maritime guidance" })?.source], ["carrier_passthrough", "title"]);
  assert.equal(classifyItemBindingPosition({ title: "A plain notice" }), null, "never guessed");
  assert.equal(classifyItemBindingPosition({ title: "Carbon border adjustment update", jurisdiction_iso: ["EU"] })?.position, "direct_duty", "the generic CBAM phrase counts for an EU item");
  assert.equal(classifyItemBindingPosition({ title: "Carbon border adjustment update", jurisdiction_iso: ["GB"] }), null, "and not for another jurisdiction");
  assert.equal(classifyItemBindingPosition({ title: "Packaging and packaging waste overview", jurisdiction_iso: ["EU"] }), null, "a generic PPWR phrase never counts");
  assert.equal(classifyItemBindingPosition({ title: "Directive to states" }, contextFromClaims(["[jurisdictional_scope] This text is addressed to the Member States."]))?.position, "monitoring_only");
});

const world = (extra: Record<string, Row[]> = {}) =>
  connectDb({
    intelligence_items: [{ id: "i1", title: "FuelEU Maritime", jurisdiction_iso: ["EU"], transport_modes: ["ocean", "multimodal"], is_archived: false, instrument_identifier: null, canonical_instrument_key: null, compliance_deadline: null }],
    item_forward_events: [
      { id: "e1", intelligence_item_id: "i1", event_date: "2026-12-01", date_precision: "day", event_kind: "compliance_deadline", confidence: "high" },
      { id: "e2", intelligence_item_id: "i1", event_date: null, date_precision: null, event_kind: "other", confidence: "high" },
    ],
    section_claim_provenance: [],
    obligation_objects: [],
    obligations: [],
    ...extra,
  });

test("deriveRegister: one row per forward event, idempotent on forward_event_id, legs only, due_date and precision null together", async () => {
  const m = world();
  const dry = await deriveRegister(m.db, { dry: true });
  assert.equal(dry.counts.to_insert, 2);
  assert.equal(m.wrote("obligations", "insert").length, 0);
  const first = await deriveRegister(m.db, { dry: false });
  assert.equal(first.outcome, "ok");
  assert.equal(first.counts.inserted, 2);
  const rows = m.tables.obligations as Row[];
  assert.deepEqual(rows.map((r) => r.forward_event_id).sort(), ["e1", "e2"]);
  const e1 = rows.find((r) => r.forward_event_id === "e1");
  assert.deepEqual(e1?.modes, ["ocean"], "multimodal is not a leg");
  assert.equal(e1?.binding_position, "carrier_passthrough");
  const e2 = rows.find((r) => r.forward_event_id === "e2");
  assert.deepEqual([e2?.due_date, e2?.date_precision], [null, null]);
  const second = await deriveRegister(m.db, { dry: false });
  assert.equal(second.counts.to_insert, 0);
  assert.equal(second.counts.already_registered, 2);
  assert.equal((m.tables.obligations as Row[]).length, 2, "derive twice is idempotent");
});

test("deriveRegister: a failed context read fails the run; it does not classify by title alone", async () => {
  const m = world();
  const bad = connectDb(m.tables as Record<string, Row[]>, { failures: [{ table: "section_claim_provenance", op: "select", message: "down" }] });
  await assert.rejects(() => deriveRegister(bad.db, { dry: false }), /section_claim_provenance read failed/);
  assert.equal(bad.wrote("obligations", "insert").length, 0);
});

test("compliance deadline: the earliest future compliance_deadline, ties by confidence; never nulled when none is left", async () => {
  const rows = [
    { id: "a", intelligence_item_id: "i1", event_date: "2026-10-01", event_kind: "compliance_deadline", confidence: "high" },
    { id: "b", intelligence_item_id: "i1", event_date: "2026-12-01", event_kind: "compliance_deadline", confidence: "medium" },
    { id: "c", intelligence_item_id: "i1", event_date: "2026-12-01", event_kind: "compliance_deadline", confidence: "high" },
    { id: "d", intelligence_item_id: "i1", event_date: "2026-11-01", event_kind: "other", confidence: "high" },
  ];
  const picked = world({ item_forward_events: rows });
  assert.deepEqual(await syncComplianceDeadline(picked.db, "i1", TODAY, { dry: true }), { changed: true, value: "2026-12-01" }, "the earliest future compliance_deadline; the earlier 'other' event is not one");
  assert.deepEqual(await syncComplianceDeadline(picked.db, "i1", "2027-01-01", { dry: true }), { changed: false, reason: "no future compliance_deadline event" });
  const m = world();
  assert.deepEqual(await syncComplianceDeadline(m.db, "i1", TODAY), { changed: true, value: "2026-12-01" });
  assert.equal((m.tables.intelligence_items as Row[])[0]?.compliance_deadline, "2026-12-01");
  const later = await syncComplianceDeadline(m.db, "i1", "2027-06-01");
  assert.equal(later.changed, false);
  assert.equal((m.tables.intelligence_items as Row[])[0]?.compliance_deadline, "2026-12-01", "INV-220: a lapsed deadline stays");
  assert.deepEqual(await syncComplianceDeadline(m.db, "i1", TODAY), { changed: false, reason: "already up to date" });
});

const ob = (id: string, due: string | null, over: Row = {}): Row => {
  const item = { id: `it-${id}`, title: `Item ${id}`, legacy_id: null, jurisdiction_iso: ["EU"], provenance_status: "verified", is_archived: false };
  return { id, intelligence_item_id: item.id, forward_event_id: `fe-${id}`, jurisdiction: ["eu"], modes: ["ocean"], binding_position: "direct_duty", due_date: due, date_precision: due ? "day" : null, event_kind: "compliance_deadline", status: "active", item_forward_events: { obligation_text: `Text ${id}` }, item, ...over };
};
const register = () => [ob("o1", "2026-11-01"), ob("o2", "2026-10-20"), ob("o3", "2026-09-01"), ob("o4", "2026-01-01"), ob("o5", null), ob("o6", "2026-11-15", { jurisdiction: ["gb"], modes: ["road"] }), ob("o7", "2026-10-30", { binding_position: null }), ob("o8", "2026-10-25", { item: { id: "it-o8", title: "Draft", legacy_id: null, jurisdiction_iso: ["EU"], provenance_status: "draft", is_archived: false } }), ob("o9", "2026-10-26", { status: "archived" })];

test("register read: next-due order (upcoming soonest, past most recent, undated), and the total equals the count under the same filters (INV-221)", async () => {
  const m = connectDb({ obligations: register() });
  const spec = buildRegisterQuerySpec({ limit: 100 }, TODAY);
  const all = await fetchObligationRegisterPage(m.db, spec);
  assert.deepEqual(all.rows.map((r) => r.id), ["o2", "o7", "o1", "o6", "o3", "o4", "o5"], "the draft item and the archived obligation never appear");
  assert.equal(all.total, 7);
  const cases: Record<string, unknown>[] = [{ mode: "road" }, { bindingPosition: "unclassified" }, { dueWindow: "overdue" }, { dueWindow: "30" }, { dueWindow: "undated" }, { bindingPosition: "direct_duty", dueWindow: "365" }];
  for (const c of cases) {
    const s = buildRegisterQuerySpec({ ...c, limit: 100 }, TODAY);
    const page = await fetchObligationRegisterPage(m.db, s);
    assert.equal(page.total, page.rows.length, `total equals rows for ${JSON.stringify(c)}`);
  }
  const paged: string[] = [];
  for (let offset = 0; offset < 7; offset += 3) paged.push(...(await fetchObligationRegisterPage(m.db, buildRegisterQuerySpec({ limit: 3, offset }, TODAY))).rows.map((r) => r.id));
  assert.deepEqual(paged, all.rows.map((r) => r.id), "pages tile the list with no gap and no repeat");
  assert.equal((await fetchObligationRegisterPage(m.db, buildRegisterQuerySpec({ limit: 2 }, TODAY))).total, 7, "the total does not depend on the page size");
});

test("register read: a failed count or page read throws; it is never an empty page with a total", async () => {
  const m = connectDb({ obligations: register() }, { failures: [{ table: "obligations", op: "select", message: "down" }] });
  await assert.rejects(() => fetchObligationRegisterPage(m.db, buildRegisterQuerySpec({}, TODAY)), /down/);
});

/** The caller's client: their own auth and membership answers, and the data tables from the memory database. */
function useWorld(tables: Record<string, Row[]>, failures: { table: string; op: "select"; message: string }[] = []) {
  const mem = connectDb(tables, { failures });
  scripted.user = (request) => {
    const base = userDbFor((request?.headers.get("authorization")?.replace("Bearer ", "") ?? "anon") as Persona).db as unknown as { from: (t: string) => unknown; auth: unknown; rpc: unknown };
    const own = new Set(["org_memberships", "profiles", "workspace_settings", "organizations"]);
    return { auth: base.auth, rpc: base.rpc, from: (t: string) => (own.has(t) ? base.from(t) : (mem.db as unknown as { from: (t: string) => unknown }).from(t)) };
  };
  return mem;
}
const status = async (h: (r: Request, c: never) => Promise<Response>, p: Persona, url: string) => h(as(p, url), ctx({}) as never);

test("persona matrix: the register and upcoming routes answer any signed-in caller and refuse anon", async () => {
  useWorld({ obligations: register(), item_forward_events: [{ id: "f1", intelligence_item_id: "it-o1", event_date: "2026-11-01", date_precision: "day", event_kind: "compliance_deadline", obligation_text: "x", source_kind: "s", confidence: "high", item: { id: "it-o1", title: "T", legacy_id: null, jurisdiction_iso: ["EU"], transport_modes: ["ocean"], provenance_status: "verified", is_archived: false } }] });
  for (const p of PERSONAS) {
    const want = p === "anon" ? 401 : 200;
    assert.equal((await status(registerGet, p, "/api/obligations/register")).status, want, `register as ${p}`);
    assert.equal((await status(upcomingGet, p, "/api/obligations/upcoming?scope=all")).status, want, `upcoming as ${p}`);
  }
  const res = await status(registerGet, "member", "/api/obligations/register");
  const body = (await res.json()) as { rows: unknown[]; total: number };
  assert.equal(body.total, body.rows.length);
  assert.equal(body.total, 7);
  const up = (await (await status(upcomingGet, "member", "/api/obligations/upcoming?scope=all")).json()) as { events: unknown[] };
  assert.equal(up.events.length, 1);
});

test("a failed read is a 503 with Retry-After on both routes, never an empty 200", async () => {
  useWorld({}, [{ table: "obligations", op: "select", message: "down" }, { table: "item_forward_events", op: "select", message: "down" }]);
  for (const [h, url] of [[registerGet, "/api/obligations/register"], [upcomingGet, "/api/obligations/upcoming?scope=all"]] as const) {
    const res = await status(h as never, "member", url);
    assert.equal(res.status, 503, url);
    assert.ok(res.headers.get("retry-after"), `${url} sends Retry-After`);
  }
});

test("the rail takes events inside 30 days, soonest first, at most four", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const ev = (d: string) => ({ event_date: d });
  const out = selectObligationRailRows([ev("2026-12-01"), ev("2026-10-14"), ev("2026-10-30"), ev("2026-10-16"), ev("2026-10-20"), ev("2026-10-21"), ev("2026-10-22"), ev("nope")], now);
  assert.deepEqual(out.map((e) => e.event_date), ["2026-10-16", "2026-10-20", "2026-10-21", "2026-10-22"]);
});

test("createConnectDeps is the ConnectDeps the intake slice takes: four steps, a clock injected at construction", async () => {
  const m = world();
  const built: ConnectDeps = createConnectDeps({ getDb: () => m.db, now: () => new Date("2026-10-15T00:00:00Z") });
  await assert.rejects(() => built.linkEntities("missing"), /does not exist/);
  assert.deepEqual(Object.keys(built).sort(), ["connect", "deriveObligations", "extractAndInsertForwardEvents", "linkEntities"]);
  const out = await built.deriveObligations("i1");
  assert.equal(typeof out.derived, "number");
  assert.equal((m.tables.obligations as Row[]).length, 2);
});

test("obligation text is bounded at READ to 160 characters, never at the write", async () => {
  const m = connectDb({ obligations: [ob("t1", "2026-11-01", { item_forward_events: { obligation_text: "x".repeat(300) } }), ob("t2", "2026-11-02", { item_forward_events: { obligation_text: "  short  " } }), ob("t3", "2026-11-03", { item_forward_events: { obligation_text: "   " } })] });
  const rows = (await fetchObligationRegisterPage(m.db, buildRegisterQuerySpec({ limit: 100 }, TODAY))).rows;
  const text = (id: string) => rows.find((r) => r.id === id)?.obligation_text;
  assert.equal(text("t1")?.length, 161);
  assert.equal(text("t2"), "short");
  assert.equal(text("t3"), null);
  assert.equal(((m.tables.obligations as Row[])[0]?.item_forward_events as { obligation_text: string }).obligation_text.length, 300, "the stored text is whole");
});
