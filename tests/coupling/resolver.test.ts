// CONNECT-2 R1: the resolver reads every name the spine holds. Exact phrases, case-insensitive, longest first, never fuzzy; an alias under four characters, on the stoplist or naming two entities resolves nothing; the basis stays the claim id and the span.
// Red-first: the coupling vocabulary alone (the aliases, the 5.95 % resolver) resolves none of the phrases below; the spine's names resolve them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALIAS_SEEDS } from "@/core/coupling/aliases";
import { COUPLINGS, mineRefs } from "@/core/coupling";
import { admitAlias } from "@/core/coupling/alias-rules";
import { buildResolver, resolveText, type NameSource } from "@/core/coupling/resolve";
import { entityId } from "@/core/entities";

import { fixture, NOW } from "../integration/world.ts";

import { claim, ITEM, propagate } from "./_world.ts";

const DE = entityId("jurisdiction", "DE");
const HOST = entityId("organisation", "zevalliance.org");
const ACT = entityId("instrument", "UK UKSI 2018/1302");
const name = (entity_id: string, n: string, how: NameSource["how"] = "name"): NameSource => ({ entity_id, name: n, how });
const resolve = (text: string, names: NameSource[]) => resolveText(text, buildResolver(names, []));

test("the coupling vocabulary alone resolves none of these phrases; the names the spine holds resolve them, as the longest exact phrase, case-insensitive", () => {
  const aliasesOnly = COUPLINGS.flatMap((c) => c.aliases.map((a) => name(c.entityId, a, "alias")));
  const text = "Germany and the Zev Alliance (zevalliance.org) both cite the Waste and Emissions Trading Act 2003.";
  assert.deepEqual(resolve(text, aliasesOnly), [], "the vocabulary alone: nothing");
  const spine = [name(DE, "Germany"), name(HOST, "zevalliance.org"), name(ACT, "Waste and Emissions Trading Act 2003")];
  const got = resolve(text, spine);
  assert.deepEqual(got.map((m) => [m.entityId, m.how]).sort(), [[ACT, "name"], [DE, "name"], [HOST, "name"]].sort());
  assert.deepEqual(got.find((m) => m.entityId === DE)?.span, [0, 7], "the span is the text, not the phrase");
  assert.equal(resolve("GERMANY", spine)[0]?.entityId, DE, "case-insensitive");
  assert.deepEqual(resolve("Germanys, Germnay, the Germ", spine), [], "never fuzzy: not a plural, a typo or a prefix");
});

test("longest phrase first: a name inside a longer name is not a second entity", () => {
  const eu = entityId("jurisdiction", "EU");
  const ets = entityId("instrument", "32003L0087");
  const names = [name(eu, "European Union"), name(ets, "European Union Emissions Trading System")];
  assert.deepEqual(resolve("The European Union Emissions Trading System applies.", names).map((m) => m.entityId), [ets]);
  assert.deepEqual(resolve("The European Union applies.", names).map((m) => m.entityId), [eu]);
});

test("an alias under four characters, a stoplist word and a name that two entities share resolve nothing", () => {
  assert.equal(admitAlias("SAF"), false);
  assert.equal(admitAlias("HVO"), false);
  assert.equal(admitAlias("Commission"), false);
  assert.equal(admitAlias("Union"), false);
  assert.equal(admitAlias("2023"), false, "no letter");
  assert.equal(admitAlias("EU ETS"), true);
  const names = [name(DE, "SAF"), name(DE, "Commission"), name(HOST, "Springfield"), name(ACT, "Springfield")];
  assert.deepEqual(resolve("SAF, the Commission and Springfield", names), []);
  const built = buildResolver(names, []);
  assert.equal(built.ambiguous, 1, "the shared name is counted, not guessed");
  for (const a of ALIAS_SEEDS.flatMap((s) => s.aliases)) assert.ok(admitAlias(a), a);
});

test("the refs pass resolves a jurisdiction by its country name, an organisation by its host and an instrument by its item's title, with the claim id and span as the basis", async () => {
  const f = fixture();
  f.db.seed("entities", [
    { entity_id: DE, kind: "jurisdiction", canonical_name: "DE", display_name: null, status: "active" },
    { entity_id: HOST, kind: "organisation", canonical_name: "zevalliance.org", display_name: null, status: "active" },
    { entity_id: ACT, kind: "instrument", canonical_name: "UK UKSI 2018/1302", display_name: null, status: "active" },
  ]);
  f.db.seed("intelligence_items", [{ id: ITEM.reg, title: "The Waste and Emissions Trading Act 2003", item_type: "regulation", domain: 1, instrument_entity_id: ACT, added_date: "2026-01-01", provenance_status: "unverified", is_archived: false }]);
  const c = claim(ITEM.reg, "Germany named zevalliance.org in the Waste and Emissions Trading Act 2003 reporting duty.", "2026-10-01", "b1000000-0000-4000-8000-000000000041", 1);
  f.db.seed("section_claim_provenance", [c]);
  await propagate(f);
  const mine = f.db.rows("entity_refs").filter((r) => r.ref_id === c.id);
  assert.deepEqual(mine.map((r) => [r.entity_id, r.role]).sort(), [[ACT, "cites_instrument"], [DE, "cites_jurisdiction"], [HOST, "cites_organisation"]].sort());
  const de = mine.find((r) => r.entity_id === DE)?.basis as { claim_id: string; span: number[]; how: string };
  assert.deepEqual([de.claim_id, de.span, de.how], [c.id, [0, 7], "name"]);
  const again = await mineRefs({ sb: f.d.sb, now: () => NOW }, { dry: false });
  assert.equal(again.counts.refs_written, 0, "a second run writes none");
  assert.ok((again.counts.claim_refs_jurisdiction ?? 0) >= 1 && (again.counts.claim_refs_organisation ?? 0) >= 1, "the counts by entity kind");
});

test("the alias seeds are written with the page they come from and resolve their phrase after the seeds pass", async () => {
  const f = fixture();
  const c = claim(ITEM.reg, "The Official Journal and the European Union published the EU ETS notice.", "2026-10-01", "b1000000-0000-4000-8000-000000000042", 1);
  f.db.seed("section_claim_provenance", [c]);
  await propagate(f);
  const rows = f.db.rows("entity_aliases").filter((a) => a.alias_kind === "short_name");
  assert.equal(rows.length, ALIAS_SEEDS.reduce((n, s) => n + s.aliases.length, 0));
  for (const r of rows) {
    assert.ok(r.source_id, `${String(r.alias)} carries its source`);
    assert.equal((r.provenance as { citation: { sourceClass: string } }).citation.sourceClass, "primary");
  }
  const hits = f.db.rows("entity_refs").filter((r) => r.ref_id === c.id).map((r) => (r.basis as { how: string }).how);
  assert.deepEqual(hits.sort(), ["alias", "alias", "alias"], "Official Journal, European Union and EU ETS resolve through the aliases the seeds wrote");
});

test("every citation carries its source class: an encyclopaedia page is a reference, every other page primary", () => {
  const cites = [...COUPLINGS.flatMap((c) => (c.citation ? [c.citation] : [])), ...ALIAS_SEEDS.map((a) => a.citation)];
  for (const c of cites) assert.equal(c.sourceClass, /wikipedia\.org/.test(c.url) ? "reference" : "primary", c.url);
  assert.ok(cites.some((c) => c.sourceClass === "reference") && cites.some((c) => c.sourceClass === "primary"));
});
