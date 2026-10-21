import assert from "node:assert/strict";
import { test } from "node:test";

import { extractCellarTitle, normalizeDisplayTitle } from "@/core/fetch/titles";

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
