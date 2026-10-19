import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { DOCUMENTS, ROWS, compareOutputs, licenceClass, parseLiteral, type GoldenRow } from "@/core/golden/load";

import { getDoc, hasToken, type FetchedDoc } from "./_docs.ts";
import { renderReadme } from "./_readme.ts";
import { relationProblems } from "./_relations.ts";
import { proseOverlap, redDocs, structureProblems } from "./_structure.ts";

const README = new URL("../../src/core/golden/data/README.md", import.meta.url);
const byId = (id: string): GoldenRow => ROWS.find((r) => r.id === id) as GoldenRow;

test("the corpus carries T1 to T20, five adversarial rows and two locale-collision rows", () => {
  for (let n = 1; n <= 20; n += 1) assert.ok(byId(`T${n}`), `T${n} is missing`);
  assert.ok(ROWS.filter((r) => r.kind === "adversarial").length >= 5, "at least five adversarial rows");
  assert.ok(ROWS.filter((r) => r.kind === "locale_collision").length >= 2, "at least two locale-collision rows");
  assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length);
});

test("INV-R6a-1: a row is verified with a locator that carries probes, or unresolved with a reason and no expected value", () => {
  for (const r of ROWS) {
    if (r.status === "verified") assert.ok(r.checks.length > 0 && r.retrieved, `${r.id} verified without a locator`);
    else assert.ok(r.unresolved_reason && r.outputs.length === 0, `${r.id} unresolved row carries a value or no reason`);
  }
});

test("INV-R6a-1 bounds: every printed value is its literal under its locale, within its printed digits, and on a cited locator", () => {
  for (const r of ROWS.filter((x) => x.status === "verified")) {
    const probes = [...r.checks.flatMap((c) => c.tokens), ...r.disagreements.flatMap((d) => d.sides.flatMap((s) => s.tokens))];
    const results = new Set(r.relations.flatMap((x) => (x.type === "sum" ? [x.total] : x.type === "wtw" ? [x.wtw] : [x.result])));
    for (const q of [...r.inputs, ...r.outputs]) {
      const where = `${r.id} ${q.name}`;
      assert.equal([q.value, q.text, q.missing].filter((v) => v !== undefined).length, 1, `${where}: exactly one of value, text, missing (a typed missing is never zero-filled)`);
      if (q.origin === "derived" && q.value !== undefined) assert.ok(results.has(q.name), `${where}: a derived value is the result of a stated relation`);
      if (q.origin !== "printed" || q.value === undefined) continue;
      assert.equal(parseLiteral(q.literal!, q.locale!), q.value, `${where}: value is not its printed literal under ${q.locale}`);
      assert.ok(q.sigDigits! <= q.literal!.replace(/\D/g, "").length, `${where}: sigDigits exceeds the printed digits`);
      assert.ok(probes.some((t) => t.includes(q.literal!)), `${where}: the printed literal ${q.literal} is on no cited locator`);
    }
    for (const o of r.outputs) if (/CO2e/.test(o.unit)) assert.notEqual(o.gwp_set, "not_applicable", `${r.id} ${o.name}: a CO2e figure names its GWP set`);
  }
});

test("GLEC rows are tagged v3.0 pending v3.2, and every v3.0 GLEC row has a re-check row", () => {
  const glec = ROWS.filter((r) => r.framework === "glec" && r.framework_version === "3.0");
  assert.ok(glec.length >= 8);
  for (const r of glec) assert.equal(r.recheck_against, "3.2", r.id);
  const covered = new Set(ROWS.filter((r) => r.kind === "recheck").flatMap((r) => (r.categories?.rechecks ?? "").split(",")));
  for (const r of glec) if (/^[TA]\d+$/.test(r.id)) assert.ok(covered.has(r.id), `${r.id} has no v3.2 re-check row`);
});

test("the arithmetic each row states holds on its expected values (INV-R6a-3)", () => {
  const problems = ROWS.flatMap(relationProblems);
  assert.deepEqual(problems, []);
  assert.ok(ROWS.some((r) => r.relations.some((x) => x.type === "wtw")), "at least one WTT + TTW = WTW relation is stated");
  const a1 = byId("A1");
  assert.ok(a1.relations.some((x) => x.type === "quotient" && x.denominator === "t_per_teu"), "the tkm to TEU-km conversion with the row's own factor is stated");
});

test("INV-R6a-4: a comparison across GWP sets or boundaries is a series break the loader refuses", () => {
  const t9 = byId("T9").outputs;
  const [wtt, ttw] = [t9.find((o) => o.name === "i_wtt"), t9.find((o) => o.name === "i_ttw")];
  assert.deepEqual(compareOutputs(wtt!, ttw!), { ok: false, reason: "series_break_gwp" }, "GWP not stated on either side is not a basis for comparison");
  const stated = { ...wtt!, gwp_set: "AR5_100" as const };
  assert.deepEqual(compareOutputs(stated, { ...stated, gwp_set: "AR6_100" as const }), { ok: false, reason: "series_break_gwp" });
  assert.deepEqual(compareOutputs(stated, { ...stated, boundary: "TTW" as const }), { ok: false, reason: "series_break_boundary" });
  assert.deepEqual(compareOutputs(stated, { ...stated }), { ok: true, equal: true });
});

test("locale collision: one glyph shape, two documents, values a thousand apart", () => {
  const l1 = byId("L1").outputs[0]!;
  const l2 = byId("L2").outputs[0]!;
  assert.match(l1.literal!, /^\d,\d{3}$/);
  assert.match(l2.literal!, /^\d,\d{3}$/);
  assert.notEqual(l1.locale, l2.locale);
  assert.ok(Number(l2.value) / Number(l1.value) > 100);
  assert.equal(parseLiteral(l1.literal!, "dp"), "3114", "read under the wrong locale the MRV factor is a thousand times too large");
});

test("structure: no quotation marks, and probes against a licence-red document are bare figures", () => {
  assert.deepEqual(structureProblems(ROWS), []);
});

test("every document is registered with a licence class; no register entry means terms_unverified, never open", () => {
  assert.equal(licenceClass("glec_v3_0"), "prohibited");
  assert.equal(licenceClass("ghgp_cat4"), "terms_unverified");
  for (const k of Object.keys(DOCUMENTS)) assert.ok(["prohibited", "conditional", "terms_unverified", "permitted"].includes(licenceClass(k)));
});

type Page = { ok: true; text: string } | { ok: false; reason: string };
const pageOf = (doc: FetchedDoc, page: number | undefined): Page => {
  if (!doc.ok) return { ok: false, reason: doc.reason };
  const text = doc.pages[(page ?? 1) - 1];
  return text === undefined ? { ok: false, reason: `page ${page} is outside the document (${doc.pages.length} pages)` } : { ok: true, text };
};

test("every verified row's locator fetches today and carries its probes (a stale locator is marked in the output, never silently passed)", async (t) => {
  const docs = new Map<string, FetchedDoc>();
  for (const k of new Set(ROWS.filter((r) => r.status === "verified").flatMap((r) => [...r.checks.map((c) => c.doc), ...r.disagreements.flatMap((d) => d.sides.map((s) => s.doc))]))) {
    const d = DOCUMENTS[k]!;
    docs.set(k, await getDoc(d.url, d.format));
  }
  let stale = 0;
  for (const r of ROWS.filter((x) => x.status === "verified")) {
    await t.test(r.id, (sub) => {
      const wants = [...r.checks.map((c) => ({ ...c, label: c.section })), ...r.disagreements.flatMap((d) => d.sides.map((s) => ({ ...s, section: d.figure, label: d.figure, absent: undefined as string[] | undefined })))];
      const reasons: string[] = [];
      for (const c of wants) {
        const p = pageOf(docs.get(c.doc)!, c.page);
        if (!p.ok) { reasons.push(`${c.doc}: ${p.reason}`); continue; }
        for (const tok of c.tokens) assert.ok(hasToken(p.text, tok), `${r.id} ${c.label}: "${tok}" is not on ${c.doc} page ${c.page ?? 1}`);
        for (const ab of c.absent ?? []) assert.ok(!new RegExp(ab, "i").test(p.text), `${r.id}: "${ab}" is on ${c.doc} although the row states it is absent`);
      }
      if (reasons.length) { stale += 1; sub.diagnostic(`locator_stale ${r.id}: ${reasons.join("; ")}`); sub.skip(`locator_stale: ${reasons.join("; ")}`); }
    });
  }
  t.diagnostic(`locator_stale rows: ${stale} of ${ROWS.filter((x) => x.status === "verified").length}`);
});

test("INV-R6a-2: zero characters of licence-red prose in any row (no eight-word run shared with the fetched GLEC text)", async (t) => {
  for (const k of redDocs()) {
    const d = DOCUMENTS[k]!;
    const doc = await getDoc(d.url, d.format);
    if (!doc.ok) { t.diagnostic(`locator_stale ${k}: ${doc.reason}; the static structure check above still ran`); continue; }
    assert.deepEqual(proseOverlap(ROWS, doc.pages.join(" ")), [], `rows share prose with ${k}`);
  }
});

test("unresolved rows: the cited document is still unreadable, or the row is now resolvable and says so", async (t) => {
  for (const r of ROWS.filter((x) => x.status === "unresolved")) {
    const c = r.checks[0]!;
    const d = DOCUMENTS[c.doc]!;
    const doc = await getDoc(d.url, d.format);
    t.diagnostic(doc.ok ? `${r.id}: ${c.doc} now fetches (${doc.pages.length} pages): read it and resolve the row` : `${r.id}: ${c.doc} unreadable today (${doc.reason})`);
  }
});

test("the README is generated from the rows (drift guard)", () => {
  const want = renderReadme(ROWS);
  if (process.env.GOLDEN_WRITE_README === "1") writeFileSync(README, want);
  assert.equal(readFileSync(README, "utf8").split("\r\n").join("\n"), want,"src/core/golden/data/README.md drifted from the rows; regenerate with GOLDEN_WRITE_README=1 npm test");
});
