import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { POST } from "@/features/assistant/api/ask";
import { wireAssistantDeps } from "@/features/assistant/deps";
import { matchPassages, SKILL_PASSAGES } from "@/features/assistant/passages";
import { generateTriggerQuestions } from "@/features/learning";

import { scripted } from "../_support/fake-clients.ts";
import { scriptWithRpc } from "../_support/personas-rpc.ts";
import { dashboardWorld, ID } from "../dashboard/world.ts";
import { call, E, matrix } from "../workspace/_world.ts";

const A = { id: ID.a, title: "Alpha emissions regulation", domain: 1, item_type: "regulation" };
const ref = (pq: string) => (generateTriggerQuestions(A).find((q) => q.productQuestion === pq) as { subjectRef: string }).subjectRef;
const SECRET = "Penalty of EUR 50 000 applies to a late report.";

function world() {
  const db = dashboardWorld();
  const alpha = db.rows("intelligence_items").find((i) => i.id === ID.a) as Record<string, unknown>;
  Object.assign(alpha, { summary: "Annual emissions reporting duty for freight operators.", full_brief: `## Verbatim facts\n\nOperators **shall report** verified emissions by 30 April 2027. ${SECRET}\n\nThe duty applies to cargo aircraft.`, intersection_summary: "Overlaps the maritime ETS.", related_items: [ID.b] });
  db.seed("inference_records", [
    { inference_id: "i1", claim_text: "Reports are due on 30 April 2027.", status_token: "HYPOTHESIS", confidence: 0.6, cited_item_ids: [ID.a], supersedes: null, trigger_question_ref: ref("comply"), computed_at: "2026-10-14T00:00:00Z", admissibility: "analysis_ok" },
    { inference_id: "i2", claim_text: "Superseded answer.", status_token: "HYPOTHESIS", confidence: 0.4, cited_item_ids: [ID.a], supersedes: null, trigger_question_ref: ref("what"), computed_at: "2026-10-20T00:00:00Z", admissibility: "analysis_ok" },
    { inference_id: "i3", claim_text: "Current answer to what changed.", status_token: "CONFIRMED", confidence: 0.9, cited_item_ids: [ID.a, ID.b], supersedes: "i2", trigger_question_ref: ref("what"), computed_at: "2026-10-12T00:00:00Z", admissibility: "analysis_ok" },
    { inference_id: "i4", claim_text: "A stale answer.", status_token: "HYPOTHESIS", confidence: 0.5, cited_item_ids: [ID.a], supersedes: null, trigger_question_ref: ref("affects_me"), computed_at: "2026-10-10T00:00:00Z", admissibility: "stale" },
    { inference_id: "i5", claim_text: `A late filing means: ${SECRET}`, status_token: "HYPOTHESIS", confidence: 0.5, cited_item_ids: [ID.a], supersedes: null, trigger_question_ref: ref("invest_wait_avoid"), computed_at: "2026-10-11T00:00:00Z", admissibility: "analysis_ok" },
  ]);
  db.seed("section_claim_provenance", [{ id: "c1", intelligence_item_id: ID.a, claim_text: SECRET, section_row_id: null, claim_kind: "FACT" }]);
  db.seed("item_corrections", [{ id: "k1", item_id: ID.a, target_kind: "fact", target_ref: "c1", op: "suppress", reason: "wrong", created_at: "2026-10-13T00:00:00Z", revoked_at: null }]);
  // A signed-in member cannot read item_corrections (admin only, RLS): the Assistant must read the member-readable view (migration 0031) or it answers nothing.
  db.fail("item_corrections", "select", "permission denied for table item_corrections", { code: "42501" });
  db.views.fact_suppressions = () => db.rows("item_corrections").filter((c) => c.target_kind === "fact");
  scriptWithRpc(db);
  wireAssistantDeps({ operationsFacts: undefined });
  return db;
}
const ask = (persona: Parameters<typeof call>[1], question: string) => call(POST, persona, "POST", "/api/ask", { question });
type Body = { hits: { id: string; tier: number | null; excerpt: string | null; href: string; source: { name: string | null; citationCount: number | null } | null; relatedCount: number }[]; answers: { text: string; statusToken: string; confidence: number | null; cited: { id: string }[]; question: string }[]; passages: { id: string }[]; operations: string[]; empty: boolean; disclaimer: string };

test("persona matrix: /api/ask answers every signed-in persona; an anonymous caller is refused", async () => {
  await matrix("ask POST", async (p) => (world(), (await ask(p, "emissions")).status), E(401, 200, 200, 200, 200, 200, 200));
});

test("the answer: the citations ARE the retrieved hits, each with its source's rating, name and citation count; nothing is cited that was not retrieved", async () => {
  const db = world();
  const r = await ask("member", "emissions reporting");
  const b = r.body as unknown as Body;
  const retrieved = (db.rpcCalls.filter((c) => c.name === "search_intelligence_items").length, (await db.rpc("search_intelligence_items", { q: "emissions reporting", max_rows: 8 })).data as { id: string }[]).map((h) => h.id);
  assert.ok(b.hits.length > 0 && b.hits.every((h) => retrieved.includes(h.id)), "every citation is a hit of the retrieval");
  const alpha = b.hits.find((h) => h.id === ID.a);
  assert.deepEqual([alpha?.tier, alpha?.source?.name, alpha?.source?.citationCount, alpha?.href, alpha?.relatedCount], [1, "EUR-Lex", 5, `/regulations/${ID.a}`, 1]);
  assert.equal(b.empty, false);
  assert.match(b.disclaimer, /not legal, regulatory, financial, or operational advice/);
});

test("the answers on record: the current inference of each standard question, labelled with its status and confidence; superseded and stale ones are absent", async () => {
  world();
  const b = (await ask("member", "emissions reporting")).body as unknown as Body;
  const by = Object.fromEntries(b.answers.map((a) => [a.text, a]));
  assert.deepEqual(Object.keys(by).sort(), ["Current answer to what changed.", "Reports are due on 30 April 2027."].sort());
  assert.deepEqual([by["Current answer to what changed."]?.statusToken, by["Current answer to what changed."]?.confidence], ["CONFIRMED", 0.9]);
  assert.deepEqual(by["Current answer to what changed."]?.cited.map((c) => c.id).sort(), [ID.a, ID.b].sort(), "the cited items resolve under the read gate");
});

test("a suppressed claim never reaches the reader: removed from the excerpt, and an answer that quotes it is withheld", async () => {
  world();
  const b = (await ask("member", "emissions reporting")).body as unknown as Body;
  const alpha = b.hits.find((h) => h.id === ID.a);
  assert.match(String(alpha?.excerpt), /shall report verified emissions by 30 April 2027/);
  assert.equal(JSON.stringify(b).includes("EUR 50 000"), false, "the suppressed sentence is nowhere in the response");
  assert.equal(b.answers.some((a) => a.text.includes("late filing")), false);
});

test("IMP-091: the Assistant answers on the member's own client with NO service key configured; the old 503 for a missing platform client is gone", async () => {
  world();
  scripted.service = null;
  const r = await ask("member", "emissions reporting");
  assert.equal(r.status, 200);
  const b = r.body as unknown as Body;
  assert.deepEqual(b.answers.map((a) => a.text).sort(), ["Current answer to what changed.", "Reports are due on 30 April 2027."]);
  assert.equal(JSON.stringify(b).includes("EUR 50 000"), false, "the suppression still applies, read through the view");
});

test("INV-263 and fail-closed: suppressions that cannot be read (the view absent included) is a 503 with Retry-After, never an unredacted answer; a failed search is a 503", async () => {
  const bad = world();
  bad.fail("fact_suppressions", "select", "relation does not exist");
  const r = await ask("member", "emissions reporting");
  assert.deepEqual([r.status, r.headers.get("retry-after")], [503, "1"]);
  const noAnswers = world();
  noAnswers.fail("inference_records", "select", "down");
  assert.equal((await ask("member", "emissions reporting")).status, 503);
  const failedSearch = world();
  failedSearch.rpcs.search_intelligence_items = () => ({ error: { message: "x" } });
  assert.equal((await ask("member", "emissions")).status, 503);
});

test("no hits: a stated empty with the platform guide where the question names its vocabulary; no suppression or answer read is made", async () => {
  world();
  scripted.service = null;
  const b = (await ask("member", "which severity labels exist")).body as unknown as Body;
  assert.deepEqual([b.empty, b.hits.length, b.answers.length], [true, 0, 0]);
  assert.deepEqual(b.passages.map((p) => p.id), ["severity-labels"]);
});

test("the question is validated: two to 500 characters", async () => {
  world();
  for (const q of ["", "a", "x".repeat(501)]) assert.equal((await ask("member", q)).status, 400, q.length.toString());
  assert.equal((await call(POST, "member", "POST", "/api/ask", {})).status, 400);
});

test("the Operations block: the wired dependency's lines are added; a failure is a 503; unwired adds none and says nothing", async () => {
  world();
  assert.deepEqual(((await ask("member", "emissions")).body as unknown as Body).operations, []);
  let seen: unknown;
  wireAssistantDeps({ operationsFacts: async (_db, input) => ((seen = input), ["EU labour cost: 41.2 EUR/h (Eurostat)"]) });
  assert.deepEqual(((await ask("member", "emissions")).body as unknown as Body).operations, ["EU labour cost: 41.2 EUR/h (Eurostat)"]);
  assert.deepEqual((seen as { jurisdictions: string[] }).jurisdictions, ["EU"]);
  wireAssistantDeps({ operationsFacts: async () => { throw new Error("down"); } });
  assert.equal((await ask("member", "emissions")).status, 503);
  wireAssistantDeps({ operationsFacts: undefined });
});

test("FREE by construction: the whole route runs with the network replaced by a throwing stub and reaches nothing, and the Assistant's server code names no model, key or metered client", async () => {
  world();
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => (calls += 1, new Response("{}"))) as never;
  try {
    assert.equal((await ask("owner", "emissions reporting")).status, 200);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(calls, 0, "zero network calls");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? files(`${dir}/${n}`) : /\.(ts|tsx)$/.test(n) ? [`${dir}/${n}`] : []));
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of files("src/features/assistant").filter((x) => !x.includes("/ui/"))) assert.doesNotMatch(code(f), /anthropic|openai|claude-|sonnet|haiku|spend|\bfetch\(|ANTHROPIC|model/i, f);
});

test("the platform guide: matched by WHOLE words from the question, best first, at most two; no match is nothing; a stray 'us' is not the United States", () => {
  assert.equal(SKILL_PASSAGES.length, 6);
  assert.deepEqual(matchPassages("What do the severity labels mean?").map((p) => p.id), ["severity-labels"]);
  assert.deepEqual(matchPassages("how are sources weighted when they conflict").map((p) => p.id), ["source-hierarchy"]);
  assert.deepEqual(matchPassages("which jurisdictions and regions do you cover on each page").map((p) => p.id).sort(), ["four-pages", "jurisdictions"]);
  assert.equal(matchPassages("tell us about lunch").length, 0);
  assert.equal(matchPassages("severities").length, 0, "a substring is not a word");
  assert.equal(matchPassages("topic category emissions fuels page surface source", 1).length, 1);
});
