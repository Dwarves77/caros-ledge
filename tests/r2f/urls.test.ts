// R2f F6 and F7: hosts and URLs by the single homes. INV-R2f-4 (canonicalUrl never lower-cases a path or a query; the JavaScript side of the fixture list the database function is run over in schema:local), host membership by
// equality or subdomain, the LOCODE read, the title slice, and the claim tier by id through the view model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseRecordSections } from "@/core/brief";
import { deriveFactCardModels, mergeAdjacentSameKind, parseFactParagraphs } from "@/core/detail/fact-model";
import { classifyHost } from "@/core/intake";
import { hostMatches, TRACKING_PARAMS } from "@/core/parse";
import { canonicalUrl } from "@/core/shared";
import { buildRecordFacts } from "@/features/intake";
import { detectPublisherShape } from "@/features/sources/holdings-audit";
import { withClaimTiers } from "@/ui/claim-tier";

const rows = (JSON.parse(readFileSync("scripts/ci/fixtures/canonical-urls.json", "utf8")) as { urls: { url: string; canonical: string }[] }).urls;

test("INV-R2f-4: canonicalUrl gives the fixture's form for every URL and never lower-cases a path or a query; every tracking parameter is dropped", () => {
  assert.deepEqual(rows.filter((r) => canonicalUrl(r.url) !== r.canonical).map((r) => r.url), []);
  assert.notEqual(canonicalUrl("https://example.com/Law/Act"), canonicalUrl("https://example.com/law/act"));
  assert.equal(canonicalUrl("https://example.com/x?Id=AbC"), "https://example.com/x?Id=AbC");
  for (const p of TRACKING_PARAMS) assert.equal(canonicalUrl(`https://example.com/Doc?Keep=1&${p}=zzz`), "https://example.com/Doc?Keep=1", p);
  assert.equal(canonicalUrl(null), null);
  assert.equal(canonicalUrl(undefined), null);
});

test("F6: a host belongs to a domain by equality or as a subdomain, never by a substring", () => {
  assert.equal(hostMatches("gov.uk", "gov.uk"), true);
  assert.equal(hostMatches("www.legislation.gov.uk", "legislation.gov.uk"), true);
  assert.equal(hostMatches("WWW.Legislation.GOV.UK.", "legislation.gov.uk"), true);
  assert.equal(hostMatches("notgov.uk", "gov.uk"), false);
  assert.equal(hostMatches("gov.uk.example.com", "gov.uk"), false);
  assert.equal(hostMatches("", "gov.uk"), false);
  assert.equal(hostMatches(null, "gov.uk"), false);
  assert.equal(classifyHost("https://eur-lex.europa.eu/x"), "eurlex");
  assert.equal(classifyHost("https://www.legislation.gov.uk/uksi/2020/1"), "uk_legislation");
  assert.equal(classifyHost("https://noteur-lex.europa.eu/x"), null, "a host that merely ends with the domain's letters is another host");
  assert.equal(classifyHost("https://federalregister.gov.example.org/x"), null);
  assert.equal(classifyHost("https://www.federalregister.gov/documents/2024/01/02/2023-12345/x"), "federal_register");
  assert.equal(detectPublisherShape("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1805"), "eur-lex");
  assert.equal(detectPublisherShape("https://example.com/eur-lex.europa.eu/mirror"), "other", "a publisher's name in a path is not the publisher");
  assert.equal(detectPublisherShape("https://example.com/gazette/news"), "other", "the word gazette in a path is not a gazette");
  assert.equal(detectPublisherShape("https://notlegislation.gov.uk/x"), "other");
  assert.equal(detectPublisherShape("https://www.govinfo.gov/content/pkg/x"), "federal-register");
  assert.equal(detectPublisherShape("https://www.thegazette.co.uk/London/issue/1"), "gazette");
  assert.equal(detectPublisherShape(null), "other");
});

const CTX = { requiredSlots: ["corridor_identity"], itemType: "market_signal", sourceUrl: "https://example.com/m" };
const corridor = (capturedText: string) => buildRecordFacts({ title: null, capturedText, ...CTX }).find((c) => c.slot_key === "corridor_identity");

test("F6 (D:12): a lane is read only from UN/LOCODEs whose country prefix is an ISO 3166 country; five capital letters that merely look like one are not a lane", () => {
  const real = corridor("The ocean service runs CNSHA - NLRTM weekly, with a transshipment call.");
  assert.equal(real?.claim_kind, "FACT");
  assert.match(real?.claim_text ?? "", /CNSHA.*NLRTM/);
  assert.equal(corridor("The FLEET to SPEED road haulage market grew in the period.")?.claim_kind, "GAP", "FLEET and SPEED are not ports: bare five-letter words");
  assert.equal(corridor("The ocean service runs XXSHA - NLRTM weekly.")?.claim_kind, "GAP", "XX is not a country");
});

test("F6 (D:143): the identity FACT is cut from the capture at the title's position whatever the case, and the slice has the title's length in the capture's own casing", () => {
  const claims = buildRecordFacts({ title: "REGULATION (EU) 2023/9999 on sustainable freight", sourceUrl: null, capturedText: "Preamble. Regulation (EU) 2023/9999 on Sustainable Freight operations follows.", requiredSlots: [], itemType: "regulation" });
  assert.equal(claims[0]?.source_span, "Regulation (EU) 2023/9999 on Sustainable Freight");
  assert.equal(buildRecordFacts({ title: "Not there", sourceUrl: null, capturedText: "Some text.", requiredSlots: [], itemType: "regulation" }).some((c) => c.slot_key === "title"), false);
});

// ---- F7 through the view model ---------------------------------------------------------------------------------------------------------------------
test("F7: the claim id travels paragraph to card to merged card; a record-grade line takes its tier from the claim whose whole text it is, and two ratings for one line draw none", () => {
  const [para] = parseFactParagraphs("**SCOPE** The rule applies to all vessels above 5,000 gross tonnage. Source: IMO, Guidelines, 2026 https://imo.org/g");
  assert.ok(para);
  const [card] = deriveFactCardModels({ ...para, claimId: "c9" });
  assert.equal(card?.claimId, "c9");
  assert.equal(deriveFactCardModels(para)[0]?.claimId, undefined, "no id from the text: the surface that binds a claim passes it");
  const merged = mergeAdjacentSameKind([...deriveFactCardModels({ ...para, claimId: "c9" }), ...deriveFactCardModels({ ...para, claimId: "c8" })]);
  assert.deepEqual([merged[0]?.claimId, merged[0]?.additionalClaims?.[0]?.claimId], ["c9", "c8"]);
  const tiers = { c9: { tier: 1, sourceName: "IMO", sourceUrl: null, text: "x" }, c8: { tier: 3, sourceName: "Press", sourceUrl: null, text: "y" } };
  assert.deepEqual([withClaimTiers(merged[0]!, tiers).provenance?.tier, withClaimTiers(merged[0]!, tiers).additionalClaims?.[0]?.provenance?.tier], [1, 3]);

  const line = "[penalty_summary] The captured source states, verbatim: «A penalty of up to EUR 50 000 applies.»";
  const sections = [{ section_key: "record_facts", content_md: `- ${line}` }];
  const rated = (map: Record<string, { tier: number | null; sourceName: string | null; sourceUrl: string | null; text: string }>) => parseRecordSections(sections, map)?.facts[0];
  assert.equal(rated({ a: { tier: 2, sourceName: "EUR-Lex", sourceUrl: null, text: line } })?.tier, 2);
  assert.equal(rated({ a: { tier: 2, sourceName: "EUR-Lex", sourceUrl: null, text: `${line} and more words after it` } })?.tier, null, "a longer claim that contains the line is not the line");
  assert.equal(rated({ a: { tier: 2, sourceName: "A", sourceUrl: null, text: line }, b: { tier: 4, sourceName: "B", sourceUrl: null, text: line } })?.tier, null, "two ratings for one line are ambiguous");
  assert.equal(rated({ a: { tier: 2, sourceName: "A", sourceUrl: null, text: line }, b: { tier: 2, sourceName: "A", sourceUrl: null, text: line } })?.tier, 2, "two claims with one rating agree");
});
