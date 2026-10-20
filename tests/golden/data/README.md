# Golden corpus truth set (R6a)

Generated from the rows by tests/golden/rows.test.ts (the drift guard); regenerate with `GOLDEN_WRITE_README=1 npm test`. Do not edit by hand.

Each row carries inputs, expected outputs, locators and traps, never a source's prose. A value is `verified` (read at its locator on the retrieval date and re-checked by the tests) or the row is `unresolved`. GLEC and ISO text is licence-red: rows hold figures, units and locators only. GLEC rows are v3.0 pending v3.2.

Conventions: `dp` locale is decimal point with comma thousands, `dc` is decimal comma with space or dot thousands; `sigDigits` counts the printed digits, trailing zeros of an integer without a decimal part not counted; a `rounded` figure is compared within half a unit of its last published digit, every other value exactly.

Rows: 35 (30 verified, 5 unresolved). Documents: 13.

| framework | rows |
|---|---|
| ecotransit_world | 2 |
| eu_cbam | 3 |
| eu_ets_maritime | 1 |
| eu_mrv | 3 |
| ghg_protocol_scope3 | 6 |
| glec | 15 |
| icao_corsia | 1 |
| imo_cii | 2 |
| uk_mgn683 | 1 |
| us_cbp | 1 |

| status | rows |
|---|---|
| unresolved | 5 |
| verified | 30 |

| kind | rows |
|---|---|
| adversarial | 7 |
| disagreement | 2 |
| locale_collision | 2 |
| recheck | 5 |
| rule | 2 |
| truth | 17 |

| licence class (worst over cited documents) | rows |
|---|---|
| permitted | 6 |
| prohibited | 26 |
| terms_unverified | 3 |

Documents whose register verdict is `unverified`, or that have no register entry (`terms_unverified`):

- mrv_annex_council: Annexes 1 and 2 to the Commission Delegated Regulation amending Regulation (EU) 2015/757, C(2023) 6728 final (Council document 14573/23 ADD 1) (European Commission, transmitted to the Council of the EU)
