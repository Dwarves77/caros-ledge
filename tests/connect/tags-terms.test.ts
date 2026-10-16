// Tags and the adopted vocabulary: the closed vocabulary has a keyword for every tag, confidence decides adoption, a removed tag is not re-added, the
// column patch is merge-only; terms are adopted by rule (items AND distinct sources), a retired term is never touched, planning is idempotent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { adoptTags, buildMergePatch, decideTagProposal, deriveTags, FIELD_CAPS, heldVocabulary, KEYWORD_MAP, TAG_FIELDS, TAG_VOCABULARY, vocabularyProblems } from "@/core/tags";
import { buildTermPlan, celexOf, decideAdoption, groupAdoptedTerms, holdingQualifies, normaliseTermKey, planLineageNeeds, validateMentionedTerms } from "@/core/vocabulary";

import { connectDb } from "./world.ts";

test("every vocabulary tag has at least one keyword and no synonym names a tag the vocabulary lacks", () => {
  assert.deepEqual(vocabularyProblems(), []);
  for (const f of TAG_FIELDS) for (const tag of TAG_VOCABULARY[f]) assert.ok(KEYWORD_MAP.some((e) => e.field === f && e.tag === tag && e.keywords.length > 0), `${f}|${tag} has a keyword`);
});

test("deriveTags: a title match is high, a body match is medium, each field is capped", () => {
  const [first, second] = KEYWORD_MAP;
  const t = deriveTags({ id: "i", title: `A note on ${first?.keywords[0]}`, full_brief: `It also discusses ${second?.keywords[0]} at length.` });
  assert.ok(t.proposals.some((p) => p.tag === first?.tag && p.confidence === "high"));
  assert.ok(t.proposals.some((p) => p.tag === second?.tag && p.confidence === "medium"));
  for (const f of TAG_FIELDS) assert.ok(t.proposals.filter((p) => p.field === f).length <= FIELD_CAPS[f]);
  assert.deepEqual(deriveTags(null).proposals, []);
});

test("decideTagProposal: high is adopted; medium needs a held tag and its evidence in the item's own text", () => {
  const tag = TAG_VOCABULARY.topic_tags[0] as string;
  const item = { title: "x", full_brief: "mentions evidencephrase here" };
  assert.equal(decideTagProposal({ field: "topic_tags", tag, evidence: "x", confidence: "high" }, item).decision, "adopt");
  assert.equal(decideTagProposal({ field: "topic_tags", tag, evidence: "evidencephrase", confidence: "medium" }, item).decision, "adopt");
  assert.equal(decideTagProposal({ field: "topic_tags", tag, evidence: "absent words", confidence: "medium" }, item).decision, "decline");
  assert.equal(decideTagProposal({ field: "topic_tags", tag: "not-a-held-tag", evidence: "evidencephrase", confidence: "medium" }, item).decision, "decline");
  assert.ok(heldVocabulary().topic_tags.has(tag));
});

test("the column patch is merge-only: existing tags stay, a removed tag is blocked, the cap holds", () => {
  const [a, b, c, d] = TAG_VOCABULARY.topic_tags as string[];
  const merged = buildMergePatch({ topic_tags: [a as string] }, [{ field: "topic_tags", tag: b as string }, { field: "topic_tags", tag: c as string }, { field: "topic_tags", tag: d as string }], { topic_tags: new Set([c as string]) });
  assert.deepEqual(merged.blockedByCorrection.topic_tags, [c]);
  assert.ok((merged.patch.topic_tags ?? []).includes(a as string), "an existing tag stays");
  assert.ok(!(merged.patch.topic_tags ?? []).includes(c as string));
  assert.ok((merged.patch.topic_tags ?? []).length <= FIELD_CAPS.topic_tags);
});

test("adoptTags: dry writes nothing; apply writes the columns and one resolved decision flag; a removal correction is honoured", async () => {
  const [a] = TAG_VOCABULARY.topic_tags as string[];
  const item = { id: "i1", title: "x", full_brief: "", topic_tags: [] as string[] };
  const proposal = { field: "topic_tags" as const, tag: a as string, evidence: "x", confidence: "high" as const };
  const dry = connectDb({ intelligence_items: [item], integrity_flags: [], item_corrections: [] });
  await adoptTags(dry.db, item, [proposal], { now: new Date("2026-10-15T00:00:00Z"), dry: true });
  assert.equal(dry.writes.filter((w) => w.op !== "select").length, 0);
  const m = connectDb({ intelligence_items: [{ ...item }], integrity_flags: [], item_corrections: [] });
  const r = await adoptTags(m.db, item, [proposal], { now: new Date("2026-10-15T00:00:00Z") });
  assert.ok(r);
  assert.deepEqual((m.tables.intelligence_items as Record<string, unknown>[])[0]?.topic_tags, [a]);
  const blocked = connectDb({ intelligence_items: [{ ...item }], integrity_flags: [], item_corrections: [{ id: "c", item_id: "i1", target_kind: "tag", target_ref: `topic_tags:${a}`, op: "remove", created_at: "2026-01-01T00:00:00Z", revoked_at: null }] });
  await adoptTags(blocked.db, item, [proposal], { now: new Date("2026-10-15T00:00:00Z") });
  assert.deepEqual((blocked.tables.intelligence_items as Record<string, unknown>[])[0]?.topic_tags, [], "an admin-removed tag does not come back");
});

test("terms: adoption needs both enough items and two distinct sources", () => {
  assert.equal(decideAdoption({ distinct_items: 3, distinct_sources: 2 }, { minItems: 3 }).adopt, true);
  assert.equal(decideAdoption({ distinct_items: 3, distinct_sources: 1 }, { minItems: 3 }).adopt, false);
  assert.equal(decideAdoption({ distinct_items: 2, distinct_sources: 2 }, { minItems: 3 }).adopt, false);
  assert.throws(() => decideAdoption({ distinct_items: 1, distinct_sources: 1 }, { minItems: 0 }));
  assert.equal(normaliseTermKey("  Sustainable   Aviation Fuel "), normaliseTermKey("sustainable aviation fuel"));
});

const mention = (item: string, source: string | null, over: Record<string, unknown> = {}) => ({ kind: "term", term_key: "saf", label: "SAF", item_id: item, source_id: source, detector: "brief-terms", surface_text: "SAF", ...over }) as never;
const NOW = "2026-10-15T00:00:00.000Z";

test("buildTermPlan: adopted by rule, a retired term untouched, and a second plan over the result changes nothing", () => {
  const derived = [mention("a", "s1"), mention("b", "s2"), mention("c", "s2")];
  const plan = buildTermPlan({ derived, persisted: [], existingTerms: [], now: NOW, minItems: 3 });
  assert.deepEqual([plan.counts.inserted, plan.counts.newly_adopted, plan.terms[0]?.next.status], [1, 1, "adopted"]);
  const existing = plan.terms.map((t) => ({ ...t.next }));
  const again = buildTermPlan({ derived: [], persisted: derived, existingTerms: existing, now: "2027-01-01T00:00:00.000Z", minItems: 3 });
  assert.equal(again.counts.unchanged, 1, "an unchanged corpus plans no write");
  assert.equal(again.newMentions.length, 0);
  const retired = buildTermPlan({ derived, persisted: [], existingTerms: existing.map((t) => ({ ...t, status: "retired" })), now: NOW, minItems: 3 });
  assert.equal(retired.counts.skipped_retired, 1);
  assert.equal(retired.terms.length, 0);
  const one = buildTermPlan({ derived: [mention("a", "s1"), mention("b", "s1")], persisted: [], existingTerms: [], now: NOW, minItems: 2 });
  assert.equal(one.terms[0]?.next.status, "proposed", "two items from one source are not enough");
});

test("mentioned terms are validated, capped and de-duplicated; a malformed payload is reported", () => {
  const ok = validateMentionedTerms([{ kind: "term", text: "SAF" }, { kind: "term", text: "SAF" }, { kind: "nope", text: "x" }, "bad"]);
  assert.equal(ok.terms.length, 1);
  assert.ok(ok.errors.length >= 1);
  assert.deepEqual(validateMentionedTerms("not a list").terms, []);
});

test("adopted terms group by kind; holding qualifies only for a live, verified, non-community item on a source at or above the floor", () => {
  const g = groupAdoptedTerms([{ kind: "standard", term_key: "iso 14083", label: "ISO 14083", status: "adopted" }, { kind: "standard", term_key: "x", status: "proposed" }]);
  assert.deepEqual(g.standard.map((e) => e.key), ["iso 14083"]);
  const item = { is_archived: false, provenance_status: "verified", origin_class: "verified", source_id: "s", item_type: "regulation" };
  assert.equal(holdingQualifies(item, { base_tier: 1 }), true);
  assert.equal(holdingQualifies({ ...item, origin_class: "community" }, { base_tier: 1 }), false);
  assert.equal(holdingQualifies({ ...item, is_archived: true }, { base_tier: 1 }), false);
  assert.equal(holdingQualifies(item, { base_tier: 7 }), false);
  assert.equal(holdingQualifies(item, { base_tier: null }), false);
});

test("lineage needs: a CELEX id is an explicit register target; any other identifier is a term-need finding", () => {
  assert.equal(celexOf("CELEX: 32023R1805"), "32023R1805");
  assert.equal(celexOf("Regulation 2023/1805"), null);
  const r = planLineageNeeds([{ identifier: "32023R1805", relationship: "implements", citing_item_id: "a" }, { identifier: "32023r1805", citing_item_id: "b" }, { identifier: "Some Act 1998", relationship: "amends", citing_item_id: "c" }]);
  assert.deepEqual(r.celex, ["32023R1805"]);
  assert.equal(r.counts.non_celex_needs, 1);
  assert.equal(r.counts.distinct_identifiers, 2);
});
