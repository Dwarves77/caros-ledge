// NO-ENTITY-LISTS-1 under ADR-053: the text resolver reads FORMAL CODES and nothing else. An instrument identifier is matched by equality on the parse module's key, a UN/LOCODE by equality on the identifiers the spine holds. No name, alias or phrase of any entity resolves,
// whatever it is: the ontology is the database, and no word list stands in for the Reader. Red-first: the green-ammonia phrase below resolved before this change (the closed ontology of couplings.json was matched as the longest exact phrase).
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResolver, resolveText } from "@/core/coupling/resolve";
import { entityId } from "@/core/entities";

const ETS = entityId("instrument", "32003L0087");
const RED = entityId("instrument", "32018L2001");
const RTM = entityId("node", "NLRTM");
const HAM = entityId("node", "DEHAM");
const instruments = [{ entity_id: ETS, canonical_name: "32003L0087" }, { entity_id: RED, canonical_name: "32018L2001" }];
const resolver = buildResolver([{ entity_id: RTM, code: "NLRTM" }, { entity_id: HAM, code: "DEHAM" }], instruments);
const hit = (text: string) => resolveText(text, resolver).map((m) => [m.entityId, m.how]);

test("an instrument stated by its number resolves by equality, in every form the parse module reads; a UN/LOCODE resolves as a whole upper-case token", () => {
  assert.deepEqual(hit("Directive 2003/87/EC applies to the sector."), [[ETS, "identifier"]]);
  assert.deepEqual(hit("see CELEX 32018L2001 and Directive 2003/87/EC"), [[RED, "identifier"], [ETS, "identifier"]]);
  assert.deepEqual(hit("Cargo moves from NLRTM to DEHAM."), [[RTM, "code"], [HAM, "code"]]);
  assert.deepEqual(hit("nlrtm, NLRTMX, xNLRTM, NLRTM2 and NL-RTM are not the code"), [], "case-sensitive, a whole token");
  assert.deepEqual(hit("Directive 1999/99/EC names no instrument the spine holds"), []);
});

test("NE1: no name, alias or phrase of any entity resolves: a fuel, a feedstock, a node, a country, a host, an organisation, a title and an acronym are words, and the resolver reads none", () => {
  for (const text of ["GREEN AMMONIA was bunkered.", "Used cooking oil and hydrotreated vegetable oil compete for feedstock.", "Shore power at the Port of Rotterdam.", "Germany and the Netherlands reported.", "zevalliance.org published the figures.", "The Waste and Emissions Trading Act 2003 applies.", "The Official Journal and the European Union published the EU ETS notice.", "SAF, as the mandate calls it, grows.", "Done at Luxembourg, 12 July 2023."]) {
    assert.deepEqual(hit(text), [], text);
  }
  assert.equal("phrases" in resolver, false, "the resolver holds no phrase table");
});

test("a code two entities hold resolves none", () => {
  const twice = buildResolver([{ entity_id: RTM, code: "NLRTM" }, { entity_id: HAM, code: "NLRTM" }], []);
  assert.deepEqual(resolveText("NLRTM", twice), []);
  assert.equal(twice.ambiguous, 1);
});
