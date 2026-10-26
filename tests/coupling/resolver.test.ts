// JOIN-1 under ADR-053: the text resolver reads formal codes and the closed ontology of couplings.json, nothing else. An instrument identifier is matched by equality on the parse module's key, a UN/LOCODE by equality on the identifiers the spine holds, a coupling's name or
// alias as the longest exact phrase. A country name, a host, an organisation, an instrument's title and a three-letter acronym resolve nothing. Red-first: the prose phrases below resolved before this change (the R1 resolver read every name the spine holds, and the stoplist
// of English words existed to keep it from false matches).
import assert from "node:assert/strict";
import { test } from "node:test";

import { COUPLINGS } from "@/core/coupling";
import { admitAlias } from "@/core/coupling/alias-rules";
import { buildResolver, resolveText } from "@/core/coupling/resolve";
import { entityId } from "@/core/entities";

const ETS = entityId("instrument", "32003L0087");
const RED = entityId("instrument", "32018L2001");
const RTM = entityId("node", "NLRTM");
const HAM = entityId("node", "DEHAM");
const AMMONIA = COUPLINGS.find((c) => c.key === "carrier:green_ammonia")?.entityId as string;
const instruments = [{ entity_id: ETS, canonical_name: "32003L0087" }, { entity_id: RED, canonical_name: "32018L2001" }];
const resolver = buildResolver(COUPLINGS.filter((c) => c.named).flatMap((c) => [c.name, ...c.aliases].filter(admitAlias).map((name) => ({ entity_id: c.entityId, name }))), [{ entity_id: RTM, code: "NLRTM" }, { entity_id: HAM, code: "DEHAM" }], instruments);
const hit = (text: string) => resolveText(text, resolver).map((m) => [m.entityId, m.how]);

test("an instrument stated by its number resolves by equality, in every form the parse module reads; a UN/LOCODE resolves as a whole upper-case token", () => {
  assert.deepEqual(hit("Directive 2003/87/EC applies to the sector."), [[ETS, "identifier"]]);
  assert.deepEqual(hit("see CELEX 32018L2001 and Directive 2003/87/EC"), [[RED, "identifier"], [ETS, "identifier"]]);
  assert.deepEqual(hit("Cargo moves from NLRTM to DEHAM."), [[RTM, "code"], [HAM, "code"]]);
  assert.deepEqual(hit("nlrtm, NLRTMX, xNLRTM, NLRTM2 and NL-RTM are not the code"), [], "case-sensitive, a whole token");
  assert.deepEqual(hit("Directive 1999/99/EC names no instrument the spine holds"), []);
});

test("a name of the closed ontology resolves as the longest exact phrase, case-insensitive, never fuzzy; a short alias is not admitted", () => {
  assert.deepEqual(hit("GREEN AMMONIA was bunkered."), [[AMMONIA, "name"]]);
  assert.deepEqual(hit("Green ammonias, green-ish ammonia and green"), [], "not a plural, not a split phrase, not a prefix");
  assert.equal(admitAlias("SAF"), false, "under four characters");
  assert.equal(admitAlias("2023"), false, "no letter");
  assert.equal(admitAlias("EU ETS"), true);
  for (const c of COUPLINGS.filter((x) => x.named)) for (const a of [c.name, ...c.aliases]) assert.ok(admitAlias(a), `${c.key}: ${a}`);
});

test("INV-JOIN-8: no country name, host, organisation, title or acronym resolves, however it is written", () => {
  for (const text of ["Germany and the Netherlands reported.", "zevalliance.org published the figures.", "The Waste and Emissions Trading Act 2003 applies.", "The Official Journal and the European Union published the EU ETS notice.", "SAF, as the mandate calls it, grows.", "Done at Luxembourg, 12 July 2023."]) {
    assert.deepEqual(hit(text), [], text);
  }
});

test("a code or a phrase two entities hold resolves none", () => {
  const twice = buildResolver([{ entity_id: AMMONIA, name: "shared phrase" }, { entity_id: RTM, name: "shared phrase" }], [{ entity_id: RTM, code: "NLRTM" }, { entity_id: HAM, code: "NLRTM" }], []);
  assert.deepEqual(resolveText("NLRTM and a shared phrase", twice), []);
  assert.equal(twice.ambiguous, 2);
});
