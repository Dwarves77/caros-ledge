// Tags and the adopted vocabulary: the closed vocabulary has a keyword for every tag, confidence decides adoption, a removed tag is not re-added, the
// column patch is merge-only; terms are adopted by rule (items AND distinct sources), a retired term is never touched, planning is idempotent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { adoptTags, deriveTags, FIELD_CAPS, heldVocabulary, KEYWORD_MAP, TAG_FIELDS } from "@/core/tags";
import synonyms from "@/core/tags/data/synonyms.json";
import { buildTermPlan, celexOf, normaliseTermKey, planLineageNeeds, planTermNeeds, readAdoptedVocabulary, recordBriefTerms } from "@/core/vocabulary";

import { connectDb } from "./world.ts";

/** The former import-time self-check of the vocabulary module, as a test: a synonym, suppression or alias that names a tag the vocabulary does not hold, and a tag with no keyword. */
function vocabularyProblems(): string[] {
  const held = heldVocabulary();
  const problems: string[] = [];
  const check = (what: string, key: string) => {
    const i = key.indexOf("|");
    const field = key.slice(0, i) as (typeof TAG_FIELDS)[number];
    if (!held[field]?.has(key.slice(i + 1))) problems.push(`${what} names tag ${key}, which is not in the live vocabulary`);
  };
  for (const k of Object.keys(synonyms.curated)) check("curated synonym", k);
  for (const k of synonyms.suppressOwnName) check("own-name suppression", k);
  for (const a of synonyms.aliases) check("alias", `${a.field}|${a.tag}`);
  for (const e of KEYWORD_MAP) if (!e.keywords.length) problems.push(`${e.field}|${e.tag} has zero keywords`);
  return problems;
}

test("every vocabulary tag has at least one keyword and no synonym names a tag the vocabulary lacks", () => {
  assert.deepEqual(vocabularyProblems(), []);
  for (const f of TAG_FIELDS) for (const tag of heldVocabulary()[f]) assert.ok(KEYWORD_MAP.some((e) => e.field === f && e.tag === tag && e.keywords.length > 0), `${f}|${tag} has a keyword`);
});

test("deriveTags: a title match is high, a body match is medium, each field is capped", () => {
  const [first, second] = KEYWORD_MAP;
  const t = deriveTags({ id: "i", title: `A note on ${first?.keywords[0]}`, full_brief: `It also discusses ${second?.keywords[0]} at length.` });
  assert.ok(t.proposals.some((p) => p.tag === first?.tag && p.confidence === "high"));
  assert.ok(t.proposals.some((p) => p.tag === second?.tag && p.confidence === "medium"));
  for (const f of TAG_FIELDS) assert.ok(t.proposals.filter((p) => p.field === f).length <= FIELD_CAPS[f]);
  assert.deepEqual(deriveTags(null).proposals, []);
});

const NOW_D = new Date("2026-10-15T00:00:00Z");
const topicTagsAfter = async (item: Record<string, unknown>, proposals: { field: "topic_tags"; tag: string; evidence: string; confidence: "high" | "medium" }[], corrections: Record<string, unknown>[] = []) => {
  const m = connectDb({ intelligence_items: [{ ...item }], integrity_flags: [], item_corrections: corrections });
  await adoptTags(m.db, item as never, proposals, { now: NOW_D });
  return (m.tables.intelligence_items as Record<string, unknown>[])[0]?.topic_tags;
};

test("tag proposals: high is adopted; medium needs a held tag and its evidence in the item's own text", async () => {
  const tag = [...heldVocabulary().topic_tags][0] as string;
  const item = { id: "i1", title: "x", full_brief: "mentions evidencephrase here", topic_tags: [] as string[] };
  assert.deepEqual(await topicTagsAfter(item, [{ field: "topic_tags", tag, evidence: "x", confidence: "high" }]), [tag]);
  assert.deepEqual(await topicTagsAfter(item, [{ field: "topic_tags", tag, evidence: "evidencephrase", confidence: "medium" }]), [tag]);
  assert.deepEqual(await topicTagsAfter(item, [{ field: "topic_tags", tag, evidence: "absent words", confidence: "medium" }]), [], "medium evidence that is not in the text declines");
  assert.deepEqual(await topicTagsAfter(item, [{ field: "topic_tags", tag: "not-a-held-tag", evidence: "evidencephrase", confidence: "medium" }]), [], "a tag the vocabulary does not hold declines");
  assert.ok(heldVocabulary().topic_tags.has(tag));
});

test("the column patch is merge-only: existing tags stay, a removed tag is blocked, the cap holds", async () => {
  const [a, b, c, d] = [...heldVocabulary().topic_tags] as string[];
  const item = { id: "i1", title: "x", full_brief: "", topic_tags: [a as string] };
  const proposals = [b, c, d].map((tag) => ({ field: "topic_tags" as const, tag: tag as string, evidence: "x", confidence: "high" as const }));
  const tags = (await topicTagsAfter(item, proposals, [{ id: "k", item_id: "i1", target_kind: "tag", target_ref: `topic_tags:${c}`, op: "remove", created_at: "2026-01-01T00:00:00Z", revoked_at: null }])) as string[];
  assert.ok(tags.includes(a as string), "an existing tag stays");
  assert.ok(!tags.includes(c as string), "an admin-removed tag is blocked");
  assert.ok(tags.length <= FIELD_CAPS.topic_tags);
});

test("adoptTags: dry writes nothing; apply writes the columns and one resolved decision flag; a removal correction is honoured", async () => {
  const [a] = [...heldVocabulary().topic_tags] as string[];
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

test("terms: a key is normalised whitespace and case", () => {
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
  const few = buildTermPlan({ derived: [mention("a", "s1"), mention("b", "s2")], persisted: [], existingTerms: [], now: NOW, minItems: 3 });
  assert.equal(few.terms[0]?.next.status, "proposed", "two sources but too few items");
  const single = buildTermPlan({ derived: [mention("a", "s2"), mention("b", "s2"), mention("c", "s2")], persisted: [], existingTerms: [], now: NOW, minItems: 3 });
  assert.equal(single.terms[0]?.next.status, "proposed", "enough items from one source");
});

test("mentioned terms are validated, capped and de-duplicated; a malformed payload is recorded as nothing", async () => {
  const inserted: unknown[] = [];
  const w = { readTerms: async () => [], insertTerms: async (rows: { kind: string; term_key: string }[]) => (inserted.push(...rows), { rows: rows.map((r, i) => ({ ...r, id: `t${i}` })) }), upsertMentions: async () => undefined };
  const out = await recordBriefTerms({ itemId: "i", terms: [{ kind: "term", text: "SAF" }, { kind: "term", text: "SAF" }, { kind: "nope", text: "x" }, "bad"], now: NOW }, w as never);
  assert.deepEqual([out.mentioned, out.terms_inserted, inserted.length], [1, 1, 1]);
  assert.equal((await recordBriefTerms({ itemId: "i", terms: "not a list", now: NOW }, w as never)).mentioned, 0);
});

test("adopted terms group by kind; holding qualifies only for a live, verified, non-community item on a source at or above the floor", async () => {
  const m = connectDb({ vocabulary_terms: [{ id: 1, kind: "standard", term_key: "iso 14083", label: "ISO 14083", status: "adopted" }, { id: 2, kind: "standard", term_key: "x", status: "proposed" }] });
  assert.deepEqual((await readAdoptedVocabulary(m.db)).adopted.standard.map((e) => e.key), ["iso 14083"]);
  const term = { id: "t1", kind: "standard", term_key: "iso 14083", label: "ISO 14083", status: "adopted", distinct_items: 3, distinct_sources: 2 };
  const item = { is_archived: false, provenance_status: "verified", origin_class: "verified", source_id: "s", item_type: "regulation" };
  const needs = (it: Record<string, unknown>, source: { base_tier: number | null }) => planTermNeeds({ terms: [term as never], mentions: [{ term_id: "t1", item_id: "i1" }], items: new Map([["i1", it as never]]), sources: new Map([["s", source]]) }).counts.needs;
  assert.equal(needs(item, { base_tier: 1 }), 0, "a live verified holding on a high-tier source satisfies the term");
  assert.equal(needs({ ...item, origin_class: "community" }, { base_tier: 1 }), 1);
  assert.equal(needs({ ...item, is_archived: true }, { base_tier: 1 }), 1);
  assert.equal(needs(item, { base_tier: 7 }), 1);
  assert.equal(needs(item, { base_tier: null }), 1);
});

test("lineage needs: a CELEX id is an explicit register target; any other identifier is a term-need finding", () => {
  assert.equal(celexOf("CELEX: 32023R1805"), "32023R1805");
  assert.equal(celexOf("Regulation 2023/1805"), null);
  const r = planLineageNeeds([{ identifier: "32023R1805", relationship: "implements", citing_item_id: "a" }, { identifier: "32023r1805", citing_item_id: "b" }, { identifier: "Some Act 1998", relationship: "amends", citing_item_id: "c" }]);
  assert.deepEqual(r.celex, ["32023R1805"]);
  assert.equal(r.counts.non_celex_needs, 1);
  assert.equal(r.counts.distinct_identifiers, 2);
});
