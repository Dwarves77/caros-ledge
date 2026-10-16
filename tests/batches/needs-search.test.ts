import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBatch } from "@/features/batches";
import { needsExporter, needKey, needKindOf, parseAppliedNote } from "@/features/batches/kinds/needs-search/needs";
import { normalizeVerdictHost, validateHostVerdictEntry } from "@/features/batches/kinds/needs-search/validate";

import { batchFile, NOW } from "./world.ts";
import { H_FLAG, L_FLAG, needsWorld, T_FLAG, type World } from "./worlds.ts";

const entry = (need_id: string, over: Record<string, unknown> = {}) => ({ need_id, url: "https://www.imo.org/en/OurWork/Environment/EEXI.aspx", institution: "International Maritime Organization", why_authoritative: "The IMO publishes the guidelines", confidence: 0.9, ...over });
const apply = (w: World, entries: unknown[], dry = false, o: Record<string, unknown> = {}) => applyBatch("needs-search", w.deps, { content: JSON.stringify(batchFile("needs-search", entries, o)), dry });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const flagOf = (w: World, id: string) => w.db.rows("integrity_flags").find((f) => f.id === id) as Record<string, unknown>;

test("the export lists the open needs of the four kinds with a key that survives the flag being re-raised; the lineage need names its absent parent", async () => {
  const w = needsWorld();
  const r = await needsExporter(w.db.client)({ limit: 50 });
  assert.equal(r.ok, true, r.error);
  const items = r.items as unknown as { need_id: string; kind: string; key: string; output: string; text: string }[];
  assert.deepEqual(items.map((i) => i.kind).sort(), ["flywheel-gap", "holdings-need", "lineage-gap", "term-need"]);
  assert.match(items.find((i) => i.kind === "lineage-gap")?.text ?? "", /Directive 2009\/28\/EC \(amends\)/);
  assert.equal(items.find((i) => i.kind === "lineage-gap")?.output, "portal_link_candidate");
  assert.equal(items.find((i) => i.kind === "term-need")?.output, "census_worklist");
  assert.equal(needKey({ kind: "term-need", subject_ref: "term-1", text: "The  IMO EEXI technical guidelines" }), items.find((i) => i.kind === "term-need")?.key.replace(/^/, ""), "whitespace and case do not change a need's key");
  assert.equal(needKindOf("nothing:here"), null);
});

test("a found url is rated by the class table, registered, turned into the census row the need kind calls for, and the need is resolved with the marker the export reads back", async () => {
  const w = needsWorld();
  const r = await apply(w, [entry(T_FLAG)]);
  assert.equal(r.counts.applied, 1, notes(r));
  const src = w.db.rows("sources").find((s) => String(s.url).includes("imo.org")) as Record<string, unknown>;
  assert.equal(src.base_tier, 2, "the tier is the class table's for the host, not the batch's");
  const census = w.db.rows("census_worklist");
  assert.equal(census.length, 1);
  assert.deepEqual([census[0]?.source_id, census[0]?.document_url, census[0]?.lane, census[0]?.dryrun_disposition], [src.id, entry(T_FLAG).url, "C", "would_mint"]);
  const f = flagOf(w, T_FLAG);
  assert.equal(f.status, "resolved");
  assert.equal(parseAppliedNote(f.resolution_note)?.url, entry(T_FLAG).url);
  assert.equal(((await needsExporter(w.db.client)({ limit: 50 })).items as unknown[]).length, 3, "a served need is not exported again");
  const writes = w.db.writes().length;
  const again = await apply(w, [entry(T_FLAG)]);
  assert.deepEqual([again.counts.already_applied, again.counts.applied], [1, 0]);
  assert.equal(w.db.writes().length, writes, "a second apply writes nothing new");
});

test("a lineage need becomes a portal candidate tied to the registered source; a need re-raised under a new flag id is the same need", async () => {
  const w = needsWorld();
  const r = await apply(w, [entry(L_FLAG, { url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009L0028", institution: "EUR-Lex" })]);
  assert.equal(r.counts.applied, 1, notes(r));
  const cand = w.db.rows("portal_link_candidates");
  assert.equal(cand.length, 1);
  assert.equal(cand[0]?.source_id, w.db.rows("sources").find((s) => String(s.url).includes("eur-lex"))?.id);
  assert.equal(w.db.rows("census_worklist").length, 0);
  assert.equal(flagOf(w, L_FLAG).status, "resolved");
});

test("INV-209 attack: an entry that carries a tier is refused; an aggregator host is never registered, a verdict included; an unrated host needs a host verdict and is then rated by its CLASS", async () => {
  const w = needsWorld();
  const tiered = await apply(w, [entry(T_FLAG, { tier: 1 })]);
  assert.match(notes(tiered), /names a source, never a tier/);
  const agg = await apply(w, [entry(T_FLAG, { url: "https://law.justia.com/regulations/eexi", host_verdict: { host: "law.justia.com", class: "legal", evidence: "it hosts the text", verdict_source: "session-lane", generated_at: NOW.toISOString() } })]);
  assert.match(notes(agg), /aggregator or hosting platform; it republishes someone else's text and is never registered, a verdict included/);
  const unrated = await apply(w, [entry(T_FLAG, { url: "https://unknownmaker.example/docs/eexi" })]);
  assert.match(notes(unrated), /the class table does not rate host unknownmaker\.example and no host verdict places it/);
  const verdictTier = await apply(w, [entry(T_FLAG, { url: "https://unknownmaker.example/docs/eexi", host_verdict: { host: "unknownmaker.example", class: "association", tier: 1, evidence: "the maker's trade body", verdict_source: "session-lane", generated_at: NOW.toISOString() } })]);
  assert.match(notes(verdictTier), /a verdict names a class, never a tier number/);
  assert.equal(w.db.rows("sources").some((s) => /justia|unknownmaker/.test(String(s.url))), false, "nothing was registered by any refusal");
  assert.equal(w.db.writes("integrity_flags").length, 0);
  const ok = await apply(w, [entry(T_FLAG, { url: "https://unknownmaker.example/docs/eexi", host_verdict: { host: "unknownmaker.example", class: "association", evidence: "the maker's trade body", verdict_source: "session-lane", generated_at: NOW.toISOString() } })]);
  assert.equal(ok.counts.applied, 1, notes(ok));
  assert.equal(w.db.rows("sources").find((s) => String(s.url).includes("unknownmaker"))?.base_tier, 4, "association is a class of the table; the tier follows from it");
  assert.deepEqual([validateHostVerdictEntry({ host: "a/b", class: "nope", verdict_source: "x", generated_at: "no" }).length > 3, normalizeVerdictHost("WWW.Example.org.")], [true, "example.org"]);
});

test("rule 18: a below-floor host is rated and registered, not refused for being low; INV-210: a bad entry is refused alone", async () => {
  const w = needsWorld();
  const r = await apply(w, [entry(T_FLAG, { url: "https://www.theicct.org/publication/eexi" }), entry(H_FLAG, { url: "not a url" }), entry("f1000000-0000-4000-8000-0000000000ff")]);
  assert.equal(r.counts.applied, 1, notes(r));
  assert.equal(r.counts.refused, 2);
  assert.equal(w.db.rows("sources").find((s) => String(s.url).includes("theicct"))?.base_tier, 6);
  assert.match(notes(r), /url is not a valid absolute url/);
  assert.match(notes(r), /unknown need \(no open need flag with this id\)/);
  const file = await apply(w, [entry(T_FLAG)], false, { authored_by: "me" });
  assert.equal(file.counts.file_refused, 1);
});

test("INV-210: every write is read back; a stored result that does not match what was written is reported as a read-back failure and the run is partial", async () => {
  const w = needsWorld();
  w.db.afterWrite = (c, d) => {
    if (c.table === "integrity_flags" && c.op === "update") for (const f of d.rows("integrity_flags")) if (f.id === T_FLAG) f.status = "open";
  };
  const r = await apply(w, [entry(T_FLAG)]);
  assert.equal(r.counts.applied, 1);
  assert.equal(r.counts.read_back_failures, 1, notes(r));
  assert.equal(r.outcome, "partial");
  assert.match(notes(r), new RegExp(`${T_FLAG}: read-back failed`));
});
