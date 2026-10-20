// R2e M6, INV-R2e-5: no place name is served from a source the licence register prohibits. The table is GeoNames (CC BY 4.0) for ports and Wikidata (CC0) for countries; UN/LOCODE itself is `prohibited` in the register and
// serves nothing. The gate is attacked with a planted table whose entries name the prohibited source, an unregistered one and a conditional one: every one must serve null, while the same entries under a permitted source are served.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { attributionsFor, licenceGate, SOURCE_LICENCES } from "@/core/contracts/source-licence";
import raw from "@/core/entities/data/unlocode-names.json";
import { formatCorridorLabel, formatCorridorLabelCompact, nameForJurisdiction, nameSources, unlocodeName } from "@/core/entities/unlocode-names";
import { nameTable } from "@/core/entities/unlocode-table";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? walk(`${dir}/${n}`) : /\.(ts|tsx)$/.test(n) ? [`${dir}/${n}`] : []));
const entry = (source: string) => ({ ports: { NLRTM: { place: "Rotterdam", countryIso: "NL", geonameId: 2747891, source, aliasBasis: "geonames-unlc" } }, countries: { NL: { name: "Netherlands", source } } });
const table = (source: string) => ({ provenance: {}, ...entry(source) });

test("INV-R2e-5: a name whose source the register prohibits, leaves unregistered, or has not cleared is not served: the gate is asked on every call and a refusal serves null (the raw code in a label)", () => {
  assert.equal(licenceGate("un_locode").ok, false, "the prohibited source is prohibited in the register");
  for (const source of ["un_locode", "no_such_source"]) {
    const t = nameTable(table(source));
    assert.equal(t.unlocodeName("NLRTM"), null, source);
    assert.equal(t.nameForJurisdiction("NL"), null, source);
    assert.equal(t.formatCorridorLabel({ origin: "NLRTM", dest: "NLRTM", mode: "ocean" }), "NLRTM → NLRTM, ocean", `${source}: the label shows the raw code, never a name`);
    assert.equal(t.formatCorridorLabelCompact({ origin: "NLRTM", dest: "NLRTM" }), "NLRTM – NLRTM");
  }
  const conditional = Object.values(SOURCE_LICENCES).find((l) => l.redistribution !== "permitted" && l.redistribution !== "prohibited");
  if (conditional) assert.equal(nameTable(table(conditional.key)).unlocodeName("NLRTM"), null, "a conditional source is not served until its condition is discharged");
  const served = nameTable(table("geonames"));
  assert.equal(served.unlocodeName("NLRTM"), "Rotterdam");
  assert.equal(served.nameForJurisdiction("nl"), "Netherlands");
  assert.equal(served.formatCorridorLabel({ origin: "NLRTM", dest: "NLRTM", mode: "air" }), "Rotterdam (NL) → Rotterdam (NL), air");
});

test("the committed table: every entry names a source the gate clears, every source it names has its terms URL and retrieval date recorded, and the credit travels with the data", () => {
  const t = raw as { provenance: Record<string, { source: string; url: string; retrievedOn: string; terms: string }>; ports: Record<string, { source: string }>; countries: Record<string, { source: string }> };
  const sources = new Set([...Object.values(t.ports), ...Object.values(t.countries)].map((e) => e.source));
  assert.deepEqual([...sources].sort(), ["geonames", "wikidata"]);
  for (const s of sources) {
    assert.equal(licenceGate(s).ok, true, `${s} is cleared by the register`);
    assert.match(t.provenance[s]?.terms ?? "", /^https:\/\//, `${s}: the terms URL is recorded`);
    assert.match(t.provenance[s]?.retrievedOn ?? "", /^\d{4}-\d{2}-\d{2}$/, `${s}: the retrieval date is recorded`);
    assert.ok(SOURCE_LICENCES[s]?.verifiedOn, `${s}: the register records when its terms were verified`);
  }
  assert.equal(SOURCE_LICENCES.geonames?.licence, "CC BY 4.0");
  assert.deepEqual(nameSources(), ["geonames", "wikidata"]);
  assert.ok(attributionsFor(nameSources()).some((a) => /GeoNames/.test(a) && /CC BY 4\.0/.test(a)), "the GeoNames credit is the register's own wording");
  assert.ok(!JSON.stringify(raw).includes("un_locode"), "no entry is sourced from UN/LOCODE");
});

test("coverage: every port code the tree uses is named, each with its country, and the table reaches past the five the old tree named; the country table is the ISO 3166-1 list", () => {
  const seeds = (JSON.parse(readFileSync("src/features/propagation/ops/data/corridor-seeds.json", "utf8")) as { seeds: { origin: string; dest: string }[] }).seeds;
  const inCode = [...new Set(walk("src").flatMap((f) => [...readFileSync(f, "utf8").matchAll(/([A-Z]{2}[A-Z2-9]{3})-([A-Z]{2}[A-Z2-9]{3}):(?:ocean|air|road|rail)/g)].flatMap((m) => [m[1] as string, m[2] as string])))];
  const used = [...new Set([...seeds.flatMap((s) => [s.origin, s.dest]), ...inCode])];
  assert.ok(used.length >= 5, "the tree uses at least the five ports the old table named");
  for (const code of used) assert.ok(unlocodeName(code), `${code} is in use and has no name`);
  const ports = (raw as { ports: Record<string, { countryIso: string }> }).ports;
  assert.ok(Object.keys(ports).length >= 70, "the table carries every code in use and the major ports beside them");
  for (const [code, p] of Object.entries(ports)) assert.ok(nameForJurisdiction(p.countryIso), `${code}: its country ${p.countryIso} has no name`);
  assert.ok(Object.keys((raw as { countries: object }).countries).length >= 240);
  assert.equal(nameForJurisdiction("DE"), "Germany");
  assert.equal(nameForJurisdiction("zz"), null, "an unknown code is null, never a guess");
  assert.equal(formatCorridorLabel({ origin: "CNSHA", dest: "NLRTM", mode: "ocean" }), "Shanghai (CN) → Rotterdam (NL), ocean");
  assert.equal(formatCorridorLabelCompact({ origin: "CNSHA", dest: "NLRTM", mode: "ocean" }), "Shanghai – Rotterdam · ocean");
  assert.equal(formatCorridorLabel({ origin: "XXXXX", dest: "NLRTM" }), "XXXXX → Rotterdam (NL)", "a code with no name is shown raw");
});
