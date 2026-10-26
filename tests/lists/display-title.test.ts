// TITLE-1 B1: displayTitle returns the formal act head, built from the act-type vocabulary (data/act-heads.json) and the title's own digits; anything without a head passes through. Heads are the stored titles of live production rows (read 2026-10-26).
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeDisplayTitle } from "@/core/fetch/titles";
import heads from "@/core/lists/data/act-heads.json";
import { displayTitle } from "@/core/lists/display-title";

const FULL_2122 =
  "COMMISSION IMPLEMENTING REGULATION (EU) 2023/2122 of 12 October 2023 amending Implementing Regulation (EU) 2018/2066 as regards updating the monitoring and reporting of greenhouse gas emissions pursuant to Directive 2003/87/EC of the European Parliament and of the Council (Text with EEA relevance) ‘ANNEX IIa Tier definitions for calculation-based methodologies related to regulated entities ‘ANNEX IX Minimum data and information to be retained in accordance with Article 67(1) ‘ANNEX Xa Reports on fuel suppliers and fuel use of stationary installations and, where relevant, aircraft operators and shipping companies ANNEX Xb Reports on released fuels by regulated entities";

/** [stored title (or its head), expected]. The first block is the ten longest live titles, the second ten ordinary ones, the third the other head shapes the corpus carries. */
const CASES: [string, string][] = [
  [FULL_2122, "Implementing Regulation (EU) 2023/2122"],
  ["COMMISSION DELEGATED REGULATION (EU) 2023/2486 of 27 June 2023 supplementing Regulation (EU) 2020/852 of the European Parliament and of the Council by establishing the technical screening criteria", "Delegated Regulation (EU) 2023/2486"],
  ["DIRECTIVE 2008/50/EC OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 21 May 2008 on ambient air quality and cleaner air for Europe ANNEX I DATA QUALITY OBJECTIVES ANNEX II", "Directive 2008/50/EC"],
  ["COMMISSION IMPLEMENTING REGULATION (EU) 2022/2299 of 15 November 2022 laying down rules for the application of Regulation (EU) 2018/1999", "Implementing Regulation (EU) 2022/2299"],
  ["COMMISSION DELEGATED REGULATION (EU) 2023/2772 of 31 July 2023 supplementing Directive 2013/34/EU of the European Parliament and of the Council as regards sustainability reporting standards (Text with EEA relevance) ANNEX I", "Delegated Regulation (EU) 2023/2772"],
  ["COMMISSION DELEGATED REGULATION (EU) 2026/73 of 4 July 2025 amending Delegated Regulation (EU) 2021/2178", "Delegated Regulation (EU) 2026/73"],
  ["COMMISSION IMPLEMENTING REGULATION (EU) 2022/1362 of 1 August 2022 implementing Regulation (EC) No 595/2009", "Implementing Regulation (EU) 2022/1362"],
  ["COMMISSION DELEGATED REGULATION (EU) 2022/1288 of 6 April 2022 supplementing Regulation (EU) 2019/2088", "Delegated Regulation (EU) 2022/1288"],
  ["COMMISSION IMPLEMENTING REGULATION (EU) 2020/469 of 14 February 2020 amending Regulation (EU) No 923/2012, Regulation (EU) No 139/2014", "Implementing Regulation (EU) 2020/469"],
  ["REGULATION (EC) No 1013/2006 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 14 June 2006 on shipments of waste ANNEX IA ANNEX IB", "Regulation (EC) No 1013/2006"],
  ["REGULATION (EU) 2024/573 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 7 February 2024 on fluorinated greenhouse gases (Text with EEA relevance) ANNEX", "Regulation (EU) 2024/573"],

  ["COMMISSION DECISION of 29 April 2004 concerning guidance on a provisional reference method (notified under document number C(2004) 1713) (Text with EEA relevance) (2004/470/EC)", "Commission Decision of 29 April 2004"],
  ["Commission Implementing Decision (EU) 2015/670 of 27 April 2015 on the compliance of unit rates for charging zones for 2015", "Implementing Decision (EU) 2015/670"],
  ["COMMISSION DECISION of 26 March 2013 on determining Member States’ annual emission allocations", "Commission Decision of 26 March 2013"],
  ["COMMISSION DELEGATED REGULATION (EU) No 275/2014 of 7 January 2014 amending Annex I to Regulation (EU) No 1316/2013", "Delegated Regulation (EU) No 275/2014"],
  ["COMMISSION DECISION (EU) 2025/519 of 5 March 2025 on the process for the introduction of operating restrictions at Schiphol Airport", "Decision (EU) 2025/519"],
  ["COMMISSION IMPLEMENTING REGULATION (EU) 2018/2067 of 19 December 2018 on the verification of data", "Implementing Regulation (EU) 2018/2067"],
  ["COUNCIL IMPLEMENTING DECISION (EU) 2020/1629 of 29 October 2020 authorising France to apply a reduced rate of taxation", "Implementing Decision (EU) 2020/1629"],
  ["COMMISSION IMPLEMENTING DECISION (EU) 2022/691 of 28 April 2022 amending Implementing Decision (EU) 2016/2323", "Implementing Decision (EU) 2022/691"],
  ["COMMISSION RECOMMENDATION of 21 December 2009 on the safe implementation of the use of low sulphur fuel by ships at berth", "Commission Recommendation of 21 December 2009"],
  ["Commission Decision of 3 November 2010 laying down criteria and measures for the financing of commercial demonstration projects", "Commission Decision of 3 November 2010"],

  ["Directive 2000/53/EC of the European Parliament and of the Council of 18 September 2000 on end-of life vehicles", "Directive 2000/53/EC"],
  ["2001/118/EC: Commission Decision of 16 January 2001 amending Decision 2000/532/EC", "Decision 2001/118/EC"],
  ["Council Regulation (EEC) No 1890/84 of 26 June 1984 introducing special measures", "Regulation (EEC) No 1890/84"],
  ["Council Directive 95/60/EC of 27 November 1995 on fiscal marking of gas oils and kerosene", "Directive 95/60/EC"],
  ["European Parliament and Council Directive 94/62/EC of 20 December 1994 on packaging and packaging waste", "Directive 94/62/EC"],
  ["Decision No 377/2013/EU of the European Parliament and of the Council of 24 April 2013", "Decision No 377/2013/EU"],
  ["Regulation (EU) No 598/2014 of the European Parliament and of the Council", "Regulation (EU) No 598/2014"],
  ["COMMISSION DELEGATED DIRECTIVE (EU) 2019/1 of 1 January 2019 amending", "Delegated Directive (EU) 2019/1"],
];

test("displayTitle: the ten worst, ten ordinary and other live head shapes come out as the formal act head", () => {
  for (const [stored, expected] of CASES) assert.equal(displayTitle(stored), expected, stored.slice(0, 70));
});

test("displayTitle: a title with no act head passes through unchanged (Postel's law), including a planted non-EU title", () => {
  for (const stored of [
    "Air Plan Approval; Pennsylvania; Interim Final Determination for Redesignation of the Pittsburgh Area",
    "Protocol to the 1979 Convention on long-range transboundary air pollution on long-term financing",
    "DECISION No 1/2020 OF THE JOINT COMMITTEE ESTABLISHED BY THE AGREEMENT BETWEEN THE EUROPEAN UNION AND THE SWISS CONFEDERATION of 5 November 2020",
    "22.8.2013 EN Official Journal of the European Union C 241/1 COMMISSION OPINION of 22 August 2013",
    "Final Rule: Greenhouse Gas Reporting Rule, Regulation (EU) 2023/956 is cited in passing",
    "Federal Regulation 2023/45 of the Environmental Agency",
    "",
  ])
    assert.equal(displayTitle(stored), stored);
});

test("displayTitle writes no sentence: every word of the head is in the act-type vocabulary or is the title's own text (ADR-050, ADR-053)", () => {
  const tokens = new Set([...heads.issuers.flatMap((s) => s.split(" ")), ...heads.qualifiers, ...heads.types, ...heads.legalBases.map((b) => `(${b})`), heads.numberWord, heads.dateJoiner, ...heads.months]);
  for (const [stored] of CASES) for (const w of displayTitle(stored).split(" ")) assert.ok(tokens.has(w) || stored.includes(w), `${w} in ${stored.slice(0, 50)}`);
});

test("displayTitle leaves nothing for the row to wrap: the head is short and mixed case, so the row's own normalising leaves it alone", () => {
  for (const [stored] of CASES) {
    const head = displayTitle(stored);
    if (head === stored) continue;
    assert.ok(head.length <= 60, head);
    assert.deepEqual(normalizeDisplayTitle(head), { title: head, subtitle: null });
  }
});
