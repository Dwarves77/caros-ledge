// R2f F7 (K:50, rule 20): the claim a fact paragraph states is NAMED in the paragraph (`<!-- claim:<uuid> -->`), the fact model reads it, the card reads its tier and link by that id, and a paragraph without a marker draws neither.
// The binding rule (the ONE FACT claim whose text is verbatim in the paragraph) is run on one fixture by bindClaimMarkers here and by migration 0108 in schema:local (the fixture and assertions are generated from the same file).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { bindClaimMarkers } from "@/core/brief";
import { groundBrief } from "@/core/grounding";
import { deriveFactCardModels, mergeAdjacentSameKind, parseFactParagraphs } from "@/core/detail/fact-model";
import { withClaimTiers } from "@/ui/claim-tier";

import { factClaim, ITEM, makeWorld, OFFICIAL_TEXT, OFFICIAL_URL, OTHER_TEXT, OTHER_URL } from "../intake/fixtures.ts";
import { renderClaimMarkerFixture } from "../../scripts/gen/claim-marker-fixture.mjs";

interface Cases { claims: { id: string; kind: string; text: string }[]; paragraphs: { name: string; md: string; expected: string }[]; separators: string[]; expectedCounts: { marked: number; unmarked: number; already: number; skipped: number } }
const cases = JSON.parse(readFileSync("scripts/ci/fixtures/claim-markers.json", "utf8")) as Cases;
const claims = cases.claims.map((c) => ({ id: c.id, claim_text: c.text, claim_kind: c.kind }));
const join = (pick: (p: Cases["paragraphs"][number]) => string) => cases.paragraphs.map((p, i) => pick(p) + (cases.separators[i] ?? "")).join("");

test("F7: bindClaimMarkers names the ONE FACT claim whose text is verbatim in a paragraph and nothing else, keeping every separator", () => {
  const out = bindClaimMarkers(join((p) => p.md), claims);
  assert.equal(out.markdown, join((p) => p.expected));
  assert.deepEqual({ marked: out.marked, unmarked: out.unmarked, already: out.already, skipped: out.skipped }, cases.expectedCounts);
  assert.deepEqual(cases.paragraphs.filter((p) => bindClaimMarkers(p.md, claims).markdown !== p.expected).map((p) => p.name), [], "paragraph by paragraph");
  assert.equal(bindClaimMarkers(out.markdown, claims).markdown, out.markdown, "binding twice changes nothing");
});

test("F7: migration 0108's fixture and assertions are exactly what the cases render (the SQL rule runs on the same paragraphs in schema:local)", () => {
  const { fixture, assertions } = renderClaimMarkerFixture(cases);
  const file = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  assert.equal(file("scripts/ci/fixtures/data-0108-markers.sql"), fixture);
  assert.equal(file("scripts/ci/fixtures/data-0108-markers.assert.sql"), assertions);
  const migration = file("supabase/migrations/0108_data_claim_markers.sql");
  assert.match(migration, /ONLY PLACE TEXT MATCHING EVER BINDS A CLAIM/, "the migration says it is the one place");
  assert.match(migration, />= 24/, "the SQL floor is the JavaScript floor");
});

const ID = "01080000-0000-4000-8000-0000000000c1";
const OTHER_ID = "01080000-0000-4000-8000-0000000000c2";
const CARD = "**SCOPE** The rule applies to all vessels above 5,000 gross tonnage. Source: IMO, Guidelines, 2026";
const TEXT = "**SCOPE** The rule applies to all vessels above 5,000 gross tonnage. Source: IMO, Guidelines, 2026 https://imo.org/g";

test("F7: the fact model reads the marker into the paragraph's claim id and the marker never reaches the text; an unmarked paragraph has no id", () => {
  const [marked] = parseFactParagraphs(`<!-- claim:${ID} -->\n${TEXT}`);
  assert.equal(marked?.claimId, ID);
  assert.equal(marked?.kind, "fact");
  assert.ok(!(marked?.text ?? "").includes("claim:"), marked?.text);
  const [plain] = parseFactParagraphs(TEXT);
  assert.equal(plain?.claimId, undefined);
  const two = parseFactParagraphs(`<!-- claim:${ID} -->\n${TEXT}\n\n<!-- claim:${OTHER_ID} -->\n**SCOPE** Another statement of the same kind. Source: IMO, Guidelines, 2026 https://imo.org/h`);
  const cards = mergeAdjacentSameKind(two.flatMap(deriveFactCardModels));
  assert.deepEqual([cards[0]?.claimId, cards[0]?.additionalClaims?.[0]?.claimId], [ID, OTHER_ID]);
});

test("F7: a card draws the tier and the source link of the claim its paragraph names, and none when it names none", () => {
  const map = { [ID]: { tier: 1, sourceName: "IMO", sourceUrl: "https://www.imo.org/x", text: "x" } };
  const draw = (md: string) => withClaimTiers(deriveFactCardModels(parseFactParagraphs(md)[0]!)[0]!, map).provenance;
  assert.equal(draw(`<!-- claim:${ID} -->\n${CARD}`)?.tier, 1);
  assert.equal(draw(`<!-- claim:${ID} -->\n${CARD}`)?.href, "https://www.imo.org/x");
  assert.equal(draw(CARD)?.tier ?? null, null);
  assert.equal(draw(`<!-- claim:${OTHER_ID} -->\n${CARD}`)?.tier ?? null, null, "an id the map does not hold");
});

test("F7: the grounding pass writes the marker into the section it has just written the claim for: the paragraph that states a claim names it, the one that states none does not, and a second pass changes nothing", async () => {
  const span = "A penalty of up to EUR 50 000 shall apply to an operator that fails to report within the period set out in Article 2.";
  const prose = "A paragraph of plain prose about nothing a claim states.";
  const w = makeWorld({ pool: [{ url: OFFICIAL_URL, text: OFFICIAL_TEXT }, { url: OTHER_URL, text: OTHER_TEXT }] });
  const section = `**PENALTY** ${span} Source: EUR-Lex, Regulation, 2026 ${OFFICIAL_URL}\n\n${prose}`;
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: section }]);
  const run = () => groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: () => new Date("2026-10-15T00:00:00Z") }, { itemId: ITEM, ledger: [{ ...factClaim(span, { claim_text: span }), search_result_id: null }] as never });
  const first = await run();
  assert.equal(first.counts.paragraphs_marked, 1, first.detail);
  const claim = w.db.rows("section_claim_provenance").find((c) => c.claim_kind === "FACT");
  const stored = String(w.db.rows("intelligence_item_sections")[0]?.content_md);
  assert.equal(stored, `<!-- claim:${claim?.id} -->
${section}`);
  assert.ok(stored.endsWith(prose) && !stored.split("\n\n")[1]?.includes("claim:"), "the prose paragraph names no claim");
  w.db.rows("intelligence_items").find((r) => r.id === ITEM)!.provenance_status = "quarantined";
  const again = await run();
  assert.equal(String(w.db.rows("intelligence_item_sections")[0]?.content_md), stored, "a second pass changes nothing");
  assert.equal(again.counts.paragraphs_marked, 0);
});
