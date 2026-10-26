import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTitleForRow, extractCellarTitle, normalizeDisplayTitle, officialTitle } from "@/core/fetch/titles";

test("extractCellarTitle: ignores annex p.oj-doc-ti elements and preserves act title", () => {
  const html = `
    <html>
      <body>
        <p class="oj-doc-ti">REGULATION (EU) 2024/3005 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</p>
        <p class="oj-doc-ti">of 27 November 2024</p>
        <p class="oj-doc-ti">on the transparency and integrity of Environmental, Social and Governance (ESG) rating activities</p>
        <p class="oj-doc-ti">ANNEX I</p>
        <p class="oj-doc-ti">ANNEX II</p>
      </body>
    </html>
  `;
  const res = extractCellarTitle(html);
  assert.equal(
    res?.title,
    "REGULATION (EU) 2024/3005 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 27 November 2024 on the transparency and integrity of Environmental, Social and Governance (ESG) rating activities"
  );
  assert.equal(res?.origin, "cellar_doc_title");
});

test("normalizeDisplayTitle: strips appended annexes and extracts subtitle", () => {
  const input = "REGULATION (EU) 2024/3005 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL OF 27 NOVEMBER 2024 ON THE TRANSPARENCY AND INTEGRITY OF ENVIRONMENTAL, SOCIAL AND GOVERNANCE (ESG) RATING ACTIVITIES ANNEX I ANNEX II ANNEX III";
  const { title, subtitle } = normalizeDisplayTitle(input);
  assert.equal(subtitle, "Includes Annexes I–III");
  assert.equal(
    title,
    "Regulation (EU) 2024/3005 of the European Parliament and of the Council of 27 November 2024 on the Transparency and Integrity of Environmental, Social and Governance (ESG) Rating Activities"
  );
});

test("normalizeDisplayTitle: handles single annex suffix", () => {
  const input = "REGULATION (EU) 2023/1805 ON THE USE OF RENEWABLE AND LOW-CARBON FUELS IN MARITIME TRANSPORT — ANNEX I";
  const { title, subtitle } = normalizeDisplayTitle(input);
  assert.equal(subtitle, "Includes Annex I");
  assert.equal(
    title,
    "Regulation (EU) 2023/1805 on the Use of Renewable and Low-Carbon Fuels in Maritime Transport"
  );
});

test("normalizeDisplayTitle: preserves acronyms and roman numerals", () => {
  const input = "DIRECTIVE (EU) 2023/1791 ON ENERGY EFFICIENCY AND CBAM AND IMO GHG RULES — ANNEXES I TO XV";
  const { title, subtitle } = normalizeDisplayTitle(input);
  assert.equal(subtitle, "Includes Annexes I–XV");
  assert.equal(
    title,
    "Directive (EU) 2023/1791 on Energy Efficiency and CBAM and IMO GHG Rules"
  );
});

test("normalizeDisplayTitle: leaves mixed case titles untouched except annex stripping", () => {
  const input = "Commission Regulation amending Annex XVII to Regulation (EC) No 1907/2006";
  const { title, subtitle } = normalizeDisplayTitle(input);
  assert.equal(subtitle, null);
  assert.equal(title, "Commission Regulation amending Annex XVII to Regulation (EC) No 1907/2006");
});

test("normalizeDisplayTitle: a shouting token with an apostrophe is re-cased like any other (JASONLOSH'S, O'BRIEN'S, DON'T)", () => {
  assert.equal(normalizeDisplayTitle("JASONLOSH'S BRIEF").title, "Jasonlosh's Brief");
  assert.equal(normalizeDisplayTitle("O'BRIEN'S BRIEF").title, "O'Brien's Brief");
  assert.equal(normalizeDisplayTitle("DON'T FILE THE ANNUAL REPORT LATE").title, "Don't File the Annual Report Late");
  assert.equal(normalizeDisplayTitle("O'Brien's Brief").title, "O'Brien's Brief");
});

const ACT = "COMMISSION IMPLEMENTING REGULATION (EU) 2023/2122 of 12 October 2023 amending Implementing Regulation (EU) 2018/2066 as regards updating the monitoring and reporting of greenhouse gas emissions pursuant to Directive 2003/87/EC of the European Parliament and of the Council (Text with EEA relevance)";

test("officialTitle: the title ends at the EEA marker when an annex heading follows it, else before the first quoted ANNEX, else it is left", () => {
  const withAnnexes = `${ACT} ‘ANNEX IIa Tier definitions for calculation-based methodologies ‘ANNEX IX Minimum data ANNEX Xb Reports on released fuels`;
  assert.equal(officialTitle(withAnnexes), ACT);
  assert.equal(officialTitle(`${ACT} ANNEX Amendments to Regulation (EU) 2018/2066`), ACT, "a single unnumbered annex after the marker");
  assert.equal(officialTitle(`${ACT} 'ANNEX I Foo`), ACT, "an ASCII quote");
  assert.equal(officialTitle("REGULATION (EU) 2022/1 of 1 January 2022 on reporting ‘ANNEX I Template ‘ANNEX II Notes"), "REGULATION (EU) 2022/1 of 1 January 2022 on reporting", "no marker: the first quoted ANNEX");
  assert.equal(officialTitle(ACT), ACT, "a clean title is not touched");
  assert.equal(officialTitle("COMMISSION DELEGATED REGULATION (EU) No 275/2014 of 7 January 2014 amending Annex I to Regulation (EU) No 1316/2013"), "COMMISSION DELEGATED REGULATION (EU) No 275/2014 of 7 January 2014 amending Annex I to Regulation (EU) No 1316/2013", "a mixed-case Annex inside the title is the title's own");
  const unsplittable = "DIRECTIVE 2008/50/EC on air ANNEX I DATA ‘ANNEX II Determination";
  assert.equal(officialTitle(unsplittable), unsplittable, "an ANNEX word before the quoted one: not split cleanly, left as captured");
  assert.equal(officialTitle(""), "");
});

test("the mint takes only the document's own title: a planted amending page with quoted annex headings yields the act title from every capture shape (TITLE-1 B4)", () => {
  const parts = [ACT.replace(" (Text with EEA relevance)", ""), "(Text with EEA relevance)", "‘ANNEX IIa", "Tier definitions", "‘ANNEX IX"];
  const cellar = `<html><body>${parts.map((p) => `<p class="oj-doc-ti">${p}</p>`).join("")}</body></html>`;
  assert.equal(extractCellarTitle(cellar)?.title, ACT);
  const source = { name: "EUR-Lex", url: "https://eur-lex.europa.eu/" };
  const planted = `${ACT} ‘ANNEX IIa Tier definitions ‘ANNEX IX Minimum data`;
  assert.equal(buildTitleForRow({ capture: { html: `<html><head><title>${planted}</title></head></html>`, text: "x" }, source }).title, ACT, "html <title>");
  assert.equal(buildTitleForRow({ capture: { title: planted, titleOrigin: "cellar_doc_title" }, source }).title, ACT, "the capture's resolved title");
  assert.equal(buildTitleForRow({ capture: { text: `${planted} ${"Body text. ".repeat(40)}` }, source }).title, ACT, "the body lead of a text-only capture");
});
