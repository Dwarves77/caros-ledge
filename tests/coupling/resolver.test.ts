// JOIN-1: the text resolver reads formal codes and nothing else (operator and scope reviewer, 2026-10-25: the flywheel matches no free-text words). An instrument identifier is matched by equality on the parse module's key, a UN/LOCODE by equality on the identifiers the spine
// holds; a country name, a host, a title, an alias and an acronym resolve nothing. Red-first: the prose phrases below resolved before this change (the R1 resolver read every name the spine holds) and resolve nothing now.
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

test("an instrument stated by its number resolves by equality, in every form the parse module reads; a UN/LOCODE resolves as a whole upper-case token", () => {
  const hit = (text: string) => resolveText(text, resolver).map((m) => [m.entityId, m.how]);
  assert.deepEqual(hit("Directive 2003/87/EC applies to the sector."), [[ETS, "identifier"]]);
  assert.deepEqual(hit("see CELEX 32018L2001 and Directive 2003/87/EC"), [[RED, "identifier"], [ETS, "identifier"]]);
  assert.deepEqual(hit("Cargo moves from NLRTM to DEHAM."), [[RTM, "code"], [HAM, "code"]]);
  assert.deepEqual(hit("nlrtm, NLRTMX, xNLRTM, NLRTM2 and NL-RTM are not the code"), [], "case-sensitive, a whole token");
  assert.deepEqual(hit("Directive 1999/99/EC names no instrument the spine holds"), []);
});

test("INV-JOIN-8: no word of the prose resolves: a country name, a host, a title, a short name and a listed acronym name nothing", () => {
  for (const text of ["Germany and the Netherlands reported.", "zevalliance.org published the figures.", "The Waste and Emissions Trading Act 2003 applies.", "The Official Journal and the European Union published the EU ETS notice.", "SAF, as the mandate calls it, grows.", "Done at Luxembourg, 12 July 2023."]) {
    assert.deepEqual(resolveText(text, resolver), [], text);
  }
});

test("a code two entities hold resolves none", () => {
  const twice = buildResolver([{ entity_id: RTM, code: "NLRTM" }, { entity_id: HAM, code: "NLRTM" }], []);
  assert.deepEqual(resolveText("NLRTM", twice), []);
  assert.equal(twice.codes.get("NLRTM"), null);
});
