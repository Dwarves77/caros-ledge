import assert from "node:assert/strict";
import { test } from "node:test";

import { SOURCE_LICENCES, licenceGate, mayEmbedAsSeed } from "@/core/contracts/source-licence";

import { getDoc } from "./_docs.ts";
import { DOCUMENTS, licenceClass } from "./load.ts";

/** The publishers R2g reads: register key, the verdict their own notice gives, and the golden documents that cite them. */
const R2G = {
  ghgprotocol_org: { verdict: "prohibited", docs: ["ghgp_cat4", "ghgp_cat9"] },
  ecotransit_org: { verdict: "prohibited", docs: ["ecotransit_41"] },
  consilium_europa_eu: { verdict: "unverified", docs: ["mrv_annex_council"] },
  ec_climate_europa_eu: { verdict: "permitted", docs: ["ec_maritime_ets"] },
  ec_taxation_customs_europa_eu: { verdict: "permitted", docs: ["cbam_guidance_3"] },
  mardep_gov_hk: { verdict: "prohibited", docs: ["imo_mepc338_76"] },
  icao_int: { verdict: "prohibited", docs: ["icao_corsia_newsletter_2025_10", "icao_acw_2026_corsia"] },
  mcga_gov_uk: { verdict: "permitted", docs: ["mcga_mgn683"] },
  cbp_gov: { verdict: "permitted", docs: ["cbp_232_faq"] },
} as const;
const KEYS = Object.keys(R2G) as Array<keyof typeof R2G>;

/** The sentence an entry quotes from the publisher's notice: the text between [quote] and [/quote] in its note. */
function quotedSentence(note: string | undefined): string | null {
  const m = /\[quote\]([\s\S]+?)\[\/quote\]/.exec(note ?? "");
  return m ? (m[1] as string) : null;
}
/** Whitespace, curly quotes and non-breaking spaces folded, so a page's typography never decides a match. */
const fold = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, " ").replace(/\s+/g, " ").trim();

test("INV-R2g-1 (static): every new entry is registered with the verdict its own notice gave, the day it was read, and the quoted sentence that gives it", () => {
  for (const k of KEYS) {
    const e = SOURCE_LICENCES[k];
    assert.ok(e, `${k} is not in the register`);
    assert.equal(e.redistribution, R2G[k].verdict, `${k} verdict`);
    assert.match(e.verifiedOn ?? "", /^\d{4}-\d{2}-\d{2}$/, `${k} carries the date read`);
    if (e.redistribution === "unverified") {
      assert.ok(e.blocker && e.blocker.length > 40, `${k}: an unverified entry states why the notice could not be read`);
      assert.equal(quotedSentence(e.note), null, `${k}: nothing is quoted from a notice that was not read`);
      continue;
    }
    assert.match(e.url ?? "", /^https:\/\//, `${k} terms URL`);
    const q = quotedSentence(e.note);
    assert.ok(q && q.length > 40, `${k}: the sentence that grants or withholds reuse is quoted in the note`);
    if (e.redistribution === "permitted") assert.ok(e.attribution && e.licence, `${k}: a permitted entry carries its licence and the attribution text it requires`);
    else assert.ok(e.blocker && e.attribution === null, `${k}: a prohibited entry states its blocker and no attribution`);
  }
});

test("INV-R2g-1 (live): every quoted sentence is on its terms URL today; a fetch failure is a skipped subtest, never a pass", async (t) => {
  for (const k of KEYS) {
    const e = SOURCE_LICENCES[k]!;
    const q = quotedSentence(e.note);
    if (!q) continue;
    await t.test(k, async (sub) => {
      const doc = await getDoc(e.url as string, "html");
      if (!doc.ok) return sub.skip(`terms_unreadable: ${e.url} ${doc.reason}`);
      assert.ok(fold(doc.pages.join(" ")).includes(fold(q)), `${k}: the quoted sentence is not on ${e.url}; the notice changed, re-read it and rewrite the entry`);
    });
  }
});

test("INV-R2g-2: a document's licence class is computed from the register entries it cites, never stored", () => {
  const rank = ["permitted", "conditional", "unverified", "prohibited"];
  for (const [doc, d] of Object.entries(DOCUMENTS)) {
    for (const key of d.licence_keys) assert.ok(SOURCE_LICENCES[key], `${doc} cites ${key}, which is not in the register`);
    assert.deepEqual(Object.keys(d).filter((x) => /licen[cs]e_class|redistribution|verdict/i.test(x)), [], `${doc} stores a class instead of computing it`);
    const worst = d.licence_keys.length ? Math.max(...d.licence_keys.map((key) => rank.indexOf(SOURCE_LICENCES[key]!.redistribution))) : 2;
    assert.equal(licenceClass(doc), worst === 2 ? "terms_unverified" : rank[worst], doc);
  }
  for (const k of KEYS) for (const doc of R2G[k].docs) assert.deepEqual(DOCUMENTS[doc]?.licence_keys, [k], `${doc} cites ${k} and nothing else`);
  // The class follows the register: flip one entry and the document moves with it, then put it back.
  const entry = SOURCE_LICENCES.ghgprotocol_org as { redistribution: string };
  const was = entry.redistribution;
  try {
    entry.redistribution = "permitted";
    assert.equal(licenceClass("ghgp_cat4"), "permitted");
    entry.redistribution = "unverified";
    assert.equal(licenceClass("ghgp_cat4"), "terms_unverified");
  } finally {
    entry.redistribution = was;
  }
  assert.equal(licenceClass("ghgp_cat4"), "prohibited");
});

test("INV-R2g-3: no prohibited publisher gains a permissive verdict, and an unread notice embeds nothing", () => {
  const prohibited = ["glec_framework", "iso_14083", "iea_datasets", "imo_register", "clean_cargo_carrier", "un_locode", "scac", "iata_codes", "sbti_dashboard", "ghgprotocol_org", "ecotransit_org", "mardep_gov_hk", "icao_int"];
  for (const k of prohibited) {
    assert.equal(SOURCE_LICENCES[k]?.redistribution, "prohibited", `${k} must stay prohibited`);
    assert.equal(mayEmbedAsSeed(k), false, `${k} must not embed`);
    assert.equal(licenceGate(k).ok, false, `${k} must be refused by the gate`);
  }
  for (const doc of ["glec_v3_0", "glec_v3_2", ...R2G.ghgprotocol_org.docs, ...R2G.ecotransit_org.docs, ...R2G.mardep_gov_hk.docs, ...R2G.icao_int.docs]) assert.equal(licenceClass(doc), "prohibited", doc);
  assert.equal(mayEmbedAsSeed("consilium_europa_eu"), false);
  assert.equal(licenceGate("consilium_europa_eu").ok, false);
  assert.equal(licenceClass("mrv_annex_council"), "terms_unverified");
  // The CBAM guidance carries IEA-licensed defaults: the carve-out stays on the entry and iea_datasets stays red.
  assert.match(SOURCE_LICENCES.ec_taxation_customs_europa_eu?.note ?? "", /IEA/);
  assert.equal(SOURCE_LICENCES.iea_datasets?.redistribution, "prohibited");
});
