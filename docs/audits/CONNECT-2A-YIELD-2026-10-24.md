# CONNECT-2 PR A yield, measured read-only on production (2026-10-24)

Every figure below was read from production (project kwrsbpiseruzbfwjpvsp) with read-only queries (`information_schema`, counts, small samples); nothing was written. The detectors and the resolver are TypeScript; production cannot run them, so each figure is
the SQL emulation of the same rules over the same tables, named as such. Status tokens follow standing rule 14.

## Claim resolution: the share of the 34,037 grounded claims that reach an entity

[CONFIRMED] by query (SQL emulation of `resolveText`: the 134 name and alias patterns of couplings.json on word boundaries, an alias of three characters or fewer case-sensitive, plus instrument identifiers matched by equality of year, number and type against the 1,518 instrument entities whose canonical name is a CELEX id).
Sample: the first 2,000 claims by id (`order by id limit 2000`), which is a sample, not a random one. A full-table run exceeded the statement timeout.

| claim_kind | claims | resolved to at least one entity | alias only | identifier only | both |
|---|---|---|---|---|---|
| FACT | 1,280 | 104 | 45 | 53 | 6 |
| GAP | 625 | 8 | 4 | 4 | 0 |
| ANALYSIS | 85 | 7 | 6 | 1 | 0 |
| DERIVED | 10 | 0 | 0 | 0 | 0 |
| total | 2,000 | 119 (5.95 %) | | | |

Refs the sample would write: 65 by alias, 71 by identifier (136). Extrapolated, and only as a sample figure: about 2,000 of 34,037 claims and about 2,300 claim refs. The unresolved kinds are all four: FACT 1,176, GAP 617, ANALYSIS 78, DERIVED 10 (no LEGAL claim falls in the sample).
The share is low because the vocabulary is the coupling vocabulary (feedstocks, carriers, nodes, modal-shift corridors, mandates) plus the instruments the corpus cites by number, while most claims state a duty of one instrument without naming either.
Claims naming a country, an organisation or a standard other than ISO 14083 reach no entity here; extending the resolver to those is the same pass with more aliases.

## Per detector (window as of 2026-10-24; claims count from the day their item was added)

| detector | production count | sample | false positives on the sample | status |
|---|---|---|---|---|
| P1 velocity | 1 [REFUTED 2026-10-25, see R3: 0] | 1 row below | 0 of 1 judged noise | merged to fire after the thresholds were re-derived; the first pass fired 6 and 5 were noise |
| P2 mandate and capacity | PENDING ARM-2 | none | n/a | `oem_tech_roadmaps` and `grid_connection_queues` hold 0 rows; no ratchet carries a quantity (`statutory_maximum` is null on all 1,868 obligations); 35 dated ratchets sit inside the 36-month horizon and wait for a capacity row |
| P3 lead and lag | 0 | the 4 triggers below | n/a | 4 `phase_step` events fall 60 to 180 days out (all the Brazil PNCA item, SAF), 2 rest on a source claim (one names SAF in its first 170 characters, the other states the percentage ladder); no move exists on a shared entity: the 10 non-absence claims on the vocabulary added in the last 90 days are all /regulations, no market series label resolves to a coupling |
| P4 cross-modal | 0 | none | n/a | `obligation_objects.mode` is empty on all 1,868 rows, so no mode entity is filed and the corridor_links path never opens; 0 claims in 90 days name a modal-shift corridor; 20 ratchets fall due within 90 days |
| P5 penalty and abatement | PENDING ARM-2 | none | n/a | `research_assessments_current` and `statutory_computations` hold 0 rows and no derived abatement cost exists |

### P1: the first pass and what it taught (HYPOTHESIS: judged by the lane against the evidence rows, not by the operator)

Claims span 2026-06-03 to 2026-10-21 by extraction, but 12,379 of the 22,945 non-absence claims belong to items added in the last 90 days and none to the last 30 (latest `added_date` 2026-09-04), so the 90-day window is the only one that can fire.
The first pass (a rate above the entity's own baseline, no minimum baseline) fired 6 times in that window:

| entity | claims in window | sources | items | claims in baseline | judgement |
|---|---|---|---|---|---|
| corridor:inland_waterway (alias "inland waterway transport") | 10 | 5 | 10 | 3 | noise: 1990s EEC regulations on inland waterway transport added in one batch; the phrase is the mode, not a modal shift |
| corridor:rail_road (alias "rail and road") | 6 | 4 | 6 | 0 | noise: the EC-Switzerland land transport agreement, the same batch effect |
| 32002R2099 | 16 | 4 | 4 | 0 | noise: first appearance in the corpus, a transport safety cluster added in one week |
| 32016L0797 | 16 | 6 | 6 | 0 | noise: the same, rail interoperability |
| 32016L0798 | 6 | 3 | 3 | 0 | noise: the same, rail safety |
| 32018L2001 (RED II) | 48 | 8 | 23 | 8 | plausible: 23 items added in the window cite RED II, against 8 claims before; share of flow 5.12 times its baseline share |

Five of six were noise, so the detector was held back and its thresholds re-derived from the mechanism, not from the count: (1) an entity new to the corpus has no baseline, its first appearance is coverage not velocity, so a burst needs `minBaseline` earlier citations (data/patterns.json, 3);
(2) the two corridor aliases were the modes' descriptive phrases, so the corridor class now matches the modal-shift concept only ("modal shift to rail", "road-to-rail", "shift to inland waterway transport"); (3) the rate was already the entity's share of the corpus's own flow, so a corpus that is itself growing is no burst.
After the change the same query gives 1 pattern, the last row. It is one row because the corpus is one season old; the detector reads a longer baseline as history accrues.

Sample (all rows, there is one): `cl:instrument` for CELEX 32018L2001: 48 claims from 8 independent sources over 23 items of 4 item types in 90 days (tier 1 only); baseline 8 claims in days 90 to 270; flow 12,379 claims in the window and 10,566 in the baseline; value 5.12 (ratio of shares).

### P3: the four triggers evaluated

| event id | date | item | source claim | outcome |
|---|---|---|---|---|
| bf214060-014a-49d7-b3b4-c023073153a0 | 2027-01-01 | Brazil National Policy on Alternative Fuels (PNCA) | names SAF (carrier:hefa_saf) | no move on a shared entity |
| e13b85ba-a23a-40a3-b898-3109bb6d9b3a | 2027-01-01 | the same | states the percentage ladder, no coupling in its first 170 characters | no entity found in the span, no join |
| e234dc17-cd55-44d0-a8b9-95d7a8bb09a9 | 2027-01-01 | the same | none | no entity, no join |
| 7ca0c4c5-d803-4693-9847-9867dd686529 | 2027-01-01 | the same | none | no entity, no join |

## Facts this measurement found about the tables the detectors join

- [CONFIRMED] `emission_factors` (13 rows) has no writer in the new tree: no producer or runtime inserts into it. It is mined for refs only (not joined by a detector), so INV-CN2-7 holds; its producer is ARM-1's.
- [CONFIRMED] `obligation_objects.mode` is empty on every row, `statutory_maximum` is null on every row; P2, P4 and P5 read these columns as they exist (DECIDED in the brief), so they stay quiet until the derive-objects producer fills them from verbatim spans.
- [CONFIRMED] no market series label resolves to a coupling (labels are petroleum spot prices and ECB rates); the series path of P3 and P4 opens when a biofuel, SAF or bunker series is captured.

## R1: the resolver over every name the spine holds (2026-10-25, same first 2,000 claims, same SQL emulation)

[CONFIRMED] by query. Names now resolved as exact phrases (case-insensitive, longest first, no fuzzy match): the coupling aliases, every entity's canonical and display name, a jurisdiction's country name, the identifier rows (host, ISO 3166-2), the title of the instrument an item carries, the instrument numbers by equality, and six alias seeds. A name under four characters, on the stoplist (data/resolver.json) or shared by two entities resolves nothing. The three-letter aliases of the first pass (HVO, SAF, UCO, OPS, MCS) are refused by that rule and gone.

| claim_kind | claims | before (vocabulary alone) | after |
|---|---|---|---|
| FACT | 1,280 | 104 | 242 |
| GAP | 625 | 8 | 18 |
| ANALYSIS | 85 | 7 | 23 |
| DERIVED | 10 | 0 | 0 |
| total | 2,000 | 119 (5.95 %) | 283 (14.15 %) |

By source of the match (claims that reach at least one entity through it): alias seeds 95, jurisdiction by country name 89, instrument number 64, instrument title 23, coupling mandates 16, nodes 10, instruments 9, attributes 8, carriers 4, feedstocks 1, organisation by host 10, identifier rows 10. The coupling rows are the shortened alias list typed into the query, so they are a floor.
Alias seeds written (6 aliases, 5 targets, 4 pages, all primary): "Official Journal" (eur-lex.europa.eu), "International Maritime Organization" (imo.org), "European Commission" (commission.europa.eu), "European Union" (jurisdiction EU), "EU ETS" and "EU Emissions Trading System" (Directive 2003/87/EC). icao.int (CORSIA, SAF) is barred by the licence register, so no alias or seed rests on it.

Top unresolved phrases after the change, by claims containing them (generic words the stoplist refuses are shown because they rank): Member States 106, LOCODE 47, No EUR 28, This Decision 25, EEC 20, Member State 19, This Regulation 19, The Decision 15, EUR 15, ELI 14, Contracting Parties 12, European Parliament 11, The Commission 11, EPA 10, HAS ADOPTED THIS DECISION 10, SAF 9, Annex II 8, GAP 8, GHG 8, The Regulation 8.
The next alias batch: European Parliament (europarl.europa.eu answered 403), LOCODE (UN/LOCODE is licence-barred), Contracting Parties (the agreement named in each claim), and the acronyms EEC, ELI, EPA, GHG, TIR, UAE, IMO, SAF, which the four-character rule refuses and which need their full names as the aliases.

## R1b: the listed uppercase acronyms (2026-10-25, same 2,000 claims)

[CONFIRMED] by query (SQL emulation; the acronym match is case-sensitive on whole words, exactly the rule of the resolver). The four-character floor stays for phrase matching. `data/resolver.json` now lists ten three-letter acronyms, each with the entity it expands to, the expansion and the page and verbatim quote that states it (the seeds pass writes one alias row per acronym with that source; the resolver reads only grounded rows, case-sensitively, as a whole word, so "saf", "SAFE", "SAFs" and "Safran" are not SAF):
HVO (carrier HVO), SAF (HEFA-SAF), UCO (used cooking oil), OPS (shore power), MCS (HDV charging), IMO (organisation imo.org), EPA (organisation epa.gov), GHG (attribute ghg_intensity), LNG (new carrier Liquefied natural gas), UAE (jurisdiction AE). Seven rest on a reference page (Wikipedia: HVO, UCO, SAF, MCS, EPA, LNG, UAE, marked `reference` in the stored provenance); OPS, IMO and GHG rest on primary EC and IMO pages.
Not listed: EEC, ELI, TIR, CII, EUR (no seeded entity, or not an entity).

| claim_kind | claims | vocabulary alone | + spine names and alias seeds | + acronyms |
|---|---|---|---|---|
| FACT | 1,280 | 104 | 242 | 292 |
| GAP | 625 | 8 | 18 | 22 |
| ANALYSIS | 85 | 7 | 23 | 27 |
| DERIVED | 10 | 0 | 0 | 0 |
| total | 2,000 | 119 (5.95 %) | 283 (14.15 %) | 341 (17.05 %) |

72 claims reach an entity through an acronym; the Brazil PNCA claim (the SAF phase step the P3 triggers rest on) resolves to HEFA-SAF again. Top unresolved after this change: Member States 106, LOCODE 47, No EUR 28, This Decision 25, This Regulation 19, Member State 18, EUR 15, The Decision 15, ELI 14, Contracting Parties 12, European Parliament 11, The Commission 10, HAS ADOPTED THIS DECISION 10, Annex II 8, The Regulation 8, GAP 7, TIR 7, Annex III 7; EEC (20) is also unresolved and has no seeded entity.

## R3: the five detectors re-measured after the ruled runs (2026-10-25, branch merged onto origin/main b9047dd, read-only on production)

Production (project kwrsbpiseruzbfwjpvsp) was read with `select` only. Production holds neither migration 0134 (this PR) nor any mined `entity_refs` with a method version nor any `entity_relations` (0 rows), so the detectors, run as written, would read no facts from it. Every figure below is therefore the SQL EMULATION of the same rules: refs are mined inside the query (the rules of `resolveText`), relations come from couplings.json (57), and each detector's join and threshold is applied as detect.ts states it. The emulated resolver is a phrase match on token boundaries without longest-phrase shadowing, so shares are a floor to within a few claims. Status tokens: rule 14.

Rows landed since the first measurement, as read now: oem_tech_roadmaps 6, reroute_events 3, statutory_computations 38, research_assessments_current 38, grid_connection_queues 967, market_series 2,757, regional_data_facts 92, item_forward_events 5,382, obligation_objects 1,868 (mode filled on 527, first_deadline on 1,590, statutory_maximum on 1), derived_values 44.

### Claim-resolution share

[CONFIRMED] by query (SQL emulation, full population, not a sample): of the 22,945 non-GAP claims of items added in the last 270 days (the population P1 reads, window plus baseline), 5,550 reach at least one entity: 24.19 %. Sources of the match in the emulation: the coupling vocabulary and its ten listed acronyms, the alias seeds, jurisdictions by country name, organisations by host, the title of the instrument an item carries, and instrument numbers by equality against the 1,497 CELEX identifiers. 683 entities hold at least one claim in the last 90 days. The first measurement's 17.05 % was the first 2,000 claims by id of all kinds, with a smaller name set, so the two figures are not the same base; on the first base the vocabulary alone gave 5.95 %.

### Yield per detector

| detector | rows considered | patterns found | why zero (table and key) |
|---|---|---|---|
| P1 velocity | 22,945 claims (12,379 in the 90-day window, 10,566 in the 180-day baseline); 683 entities with a window claim | 0 | the minimum of two distinct tiers or surfaces: every window claim has source tier 1 and surface regulations (`section_claim_provenance.source_tier_at_grounding`), so 681 of 683 entities cannot pass; the two with two tiers (32003L0087, commission.europa.eu) fall below their own baseline share (0.75, 0.93). The RED II pattern of the first measurement is [REFUTED]: it counted item types, which the detector does not; RED II has tiers = 1 |
| P2 mandate and capacity | 313 ratchets (35 due inside 36 months, 278 undated) of 1,868; 1,065 capacity rows (6 roadmaps, 967 grid queues, 92 regional facts) | 0 | a join that reaches but has nothing to compare: `oem_tech_roadmaps.target_year` is null on 6 of 6 (no due, no quantity); `grid_connection_queues.queue_months_p50` is null on 967 of 967 (no due) and a ratchet reaches node:grid_queues only through a verbatim text that names shore power, HDV charging or a grid queue, which 0 of 1,868 obligations do; the one ratchet with a quantity (`statutory_maximum` = EUR 40 per tonne of CO2e, EUR/tCO2e) meets capacities in MW |
| P3 lead and lag | 4 `phase_step` triggers 60 to 180 days out (no other trigger kind exists in `item_forward_events`), 2 with a source claim; 101 move candidate rows in the last 90 days (1 roadmap, 1 reroute, 38 research assessments, 1 regional fact, 60 series rows) | 0 | no move on a shared entity: 0 of the 12,379 window claims are on a surface other than regulations; the one roadmap (heavy_battery, entity carrier:renewable_electricity) and the one reroute (corridor ids outside the vocabulary) do not touch the triggers' entities (HEFA-SAF through the acronym SAF; attr:ghg_intensity through GHG); the 38 research assessments carry no entity; the 6 market series filed under EU hold one observation date, so they define no move |
| P4 cross-modal | 20 ratchets due within 90 days of today; 38 claims in the window name PPWR, CBAM or ISO 14083, 2 name a modal shift | 0 | strength below the floor: the only start with a mode (one obligation naming all five legs) falls 53 days out, strength 0.5 x (1 - 53/90) = 0.205 against `crossModal.minStrength` 0.3; the other 19 carry neither a mode nor a vocabulary term and their instruments (`obligation_objects.instrument_entity_id`) have no relation. 0 obligations of PPWR, CBAM or ISO 14083 fall due in the window |
| P5 penalty and abatement | 38 technology rows (14 with a TRL, 10 at TRL 8 or 9), 38 ceilings, 0 abatement costs | 0 | two joins that do not reach: `research_assessments_current.entity_id` is null on 38 of 38, so a technology fact has no entity and reaches nothing; and no `derived_values` row is in EUR/tCO2e (the 44 rows are carbon_intensity_tkm in gCO2e/tonne-km, market_series_delta in EUR/1000L, EUR/tonne and exchange pairs, corridor_distance_km), so no abatement fact exists. The 38 ceilings are shares (pct) and years, not EUR/tCO2e |

Status of the figures: all [CONFIRMED] by query as emulation; P1's tier finding is [CONFIRMED] against `detect.ts` (distinct = max(tier count, surface count), minDistinct 2) and the data; the first measurement's P1 row is corrected in place above.

What the data would need for each detector to find something (a producer finding, not a detector change): P1 a second tier or surface in a window (claims from market, research or operations items, or sources below tier 1); P2 a `target_year` on the roadmaps and a `queue_months_p50` on the queues; P3 a claim on a non-regulations surface or a dated move on the trigger entities; P4 an obligation with a mode inside 36 days of its due date; P5 `entity_id` on `research_assessments_current` and a derived EUR/tCO2e cost.

### 20-row samples

P1: the 20 entities with most claims in the window (all pass the source test; the failing test is named).

| entity | window claims | sources | tiers | baseline | share ratio | fails |
|---|---|---|---|---|---|---|
| eur-lex.europa.eu (organisation) | 1,064 | 399 | 1 | 44 | 20.64 | tier |
| EU (jurisdiction) | 773 | 296 | 1 | 41 | 16.09 | tier |
| 32003L0087 (EU ETS) | 106 | 15 | 2 | 121 | 0.75 | share |
| LU | 103 | 74 | 1 | 3 | 29.30 | tier |
| GB | 83 | 23 | 1 | 12 | 5.90 | tier |
| CH | 83 | 32 | 1 | 7 | 10.12 | tier |
| 32008L0068 | 70 | 23 | 1 | 3 | 19.92 | tier |
| imo.org (organisation) | 68 | 21 | 1 | 185 | 0.31 | tier, share |
| DE | 67 | 16 | 1 | 34 | 1.68 | tier |
| HR | 62 | 19 | 1 | 4 | 13.23 | tier |
| BE | 61 | 15 | 1 | 6 | 8.68 | tier |
| NL | 59 | 17 | 1 | 6 | 8.39 | tier |
| IE | 57 | 16 | 1 | 8 | 6.08 | tier |
| FR | 56 | 19 | 1 | 9 | 5.31 | tier |
| 32018L2001 (RED II) | 52 | 8 | 1 | 9 | 4.93 | tier |
| IT | 48 | 15 | 1 | 4 | 10.24 | tier |
| AT | 46 | 14 | 1 | 4 | 9.82 | tier |
| commission.europa.eu (organisation) | 46 | 16 | 2 | 42 | 0.93 | share |
| RO | 40 | 15 | 1 | 1 | 34.14 | tier, baseline |
| HU | 40 | 11 | 1 | 0 | 34.14 | tier, baseline |

P2: 6 roadmap rows and 14 queue rows (queue ids by first 8 characters; all 967 queue rows have jurisdiction GB, as_of 2026-05-29, queue_months_p50 null, demand_available_mw set).

| row | key | due | quantity |
|---|---|---|---|
| roadmap 5df98e5a | megawatt_charging (node:hdv_charging) | null (target_year null) | none |
| roadmap 6d473917 | heavy_battery (carrier:renewable_electricity) | null | none |
| roadmap 70c8d5a8 | saf_refinery (carrier:hefa_saf) | null | none |
| roadmap 89143b12 | ammonia_engine (carrier:green_ammonia) | null | none |
| roadmap 9bcb9e05 | hydrogen_fcell (no mapped entity) | null | none |
| roadmap daa8edc8 | heavy_battery (carrier:renewable_electricity) | null | none |
| queue 002a7a1d, 003d1145, 00779e4a, 008c1555, 00eeb180, 0172281f, 01a3dfe2 | node:grid_queues, GB | null | 11.9, 38.4, 7, 9.6, 10.1, 6.5, 23.3 MW |
| queue 02157916, 023f019c, 02474393, 027b8fa0, 02c5c15a, 02ece36b, 033bb239 | node:grid_queues, GB | null | 9.6, 17.6, 12.9, 8.2, 8.4, 5.7, 7.5 MW |

P3: the 4 triggers, the move rows of the window and the series labels (20 rows in all, counting each of the 12 labels).

| row | detail | outcome |
|---|---|---|
| trigger bf214060 | phase_step 2027-01-01, Brazil PNCA, claim names SAF | entity HEFA-SAF; no move in its neighbourhood |
| trigger e13b85ba | phase_step 2027-01-01, same item, claim names GHG | entity attr:ghg_intensity; no neighbour, no move |
| trigger e234dc17 | phase_step 2027-01-01, same item, no source claim | no entity, no join |
| trigger 7ca0c4c5 | phase_step 2027-01-01, same item, no source claim | no entity, no join |
| roadmap daa8edc8 | announced 2026-09-14, heavy_battery | entity carrier:renewable_electricity, not near either trigger |
| reroute 92d35ddc | effective 2026-09-19, corridor cl:corridor:b624b607add73ba4 | corridor outside the vocabulary |
| market_series labels (12 rows): Automotive gas oil / diesel (EU), Brent crude oil spot, EUR/CNY, EUR/GBP, EUR/JPY, Euro-Super 95 (EU), EUR/USD, Heating gas oil (EU), Heavy fuel oil 3.5%S (EU), Kerosene-type jet fuel spot, LPG motor fuel (EU), No. 2 diesel ultra-low sulfur spot | 60 rows in the window over 16 keys; 6 filed to EU on one date | no label names a vocabulary entity; no second observation, so no move |
| regional_data_facts (1 row), research_assessments_current (38 rows) in the window | no entity | no join |

P4: the 20 ratchets due within 90 days (by instrument and due date; obligation ids start with their first hex characters).

| rows | due (days from today) | instrument entity | modes | vocabulary term in the text |
|---|---|---|---|---|
| 5c11a230 (1 row) | 2026-12-17 (+53) | a60435a713ae77bc | road, rail, ocean, inland_waterway, air | none |
| 24238471, f8844807, b6ea3ce4, 55effd9c, e30c892b, 366fc3ae, 80c7d1a7, afd16d46, cc7c7509, c762215c, dcfa6a29 (11 rows) | 2026-12-17 (+53) | a60435a713ae77bc | none | none |
| 78c726cb, cb7e9446, 4722016a, 758856b6, 9584376c (5 rows) | 2027-01-01 (+68) | 0d579d543d287cd7 | none | none |
| ab225a27, 635b1781, 5a342471 (3 rows) | 2026-07-31 (-86) | fea72fbf2cf0fdf1 | none | none |

### Findings this measurement adds

- [CONFIRMED] P1 cannot fire while the corpus has one tier and one surface in a window: `velocity.minDistinct` 2 is met only by an entity cited by sources of two tiers, and only 2 of 683 entities in the window have two. This is a property of the corpus (every window claim is a regulations claim from a tier 1 source), not of the detector.
- [CONFIRMED] `research_assessments_current.entity_id` is null on every row: the writer of that table files no entity, so P5 and the technology side of P3 reach nothing.
- [CONFIRMED] P2 and P5 both wait on a quantity the producers do not yet fill (`target_year`, `queue_months_p50`, an EUR/tCO2e abatement cost).
- [CONFIRMED] DERIVE-2 raised `obligation_objects.mode` from 0 to 527 rows; the one P4 start it feeds is blocked by the strength floor at 53 days, not by the join.

## R4: the mining and the five detectors, run once for real (2026-10-25, production project kwrsbpiseruzbfwjpvsp, ruled plan scripts/runs/plans/2026-10-26-connect-2a.json, main 3218fef)

Four steps ran from the `ruled-runs` job of main's push run 40243970494; each row is in `harness_runs` under `inputs->>'ruled_plan'`. Status tokens: rule 14.

| step | ledger run id | family | mode | outcome | what it counted |
|---|---|---|---|---|---|
| couplings-dry | fc95d0fb-4213-45b0-8cba-f7e8e56d168d | propagation | dry | success | nothing written |
| couplings-apply | a09ec94a-e4db-4b83-8b39-dce3a431073b | propagation | apply | partial | 30 seed pages cited: 19 captured, 11 failed (capture_thin on transport.ec.europa.eu pages, robots_deferred on imo.org, others); 47 couplings, 6 refused; 37 entities, 147 aliases, 48 relations written; 34,037 claims read, 8,592 claim refs planned; 14,305 refs written; 195 events drained |
| patterns-dry | 8246cbd3-f3e4-4de1-8a22-f64d2dcfc819 | corpus-turn | dry | success | nothing written |
| patterns-apply | 64a761a9-0874-49cd-83f6-d756dfc84ffb | corpus-turn | apply | noop (see finding 3) | 19 patterns, all velocity, 19 new; refs_read 14,305, relations_read 48 |

### Production read-back after the run

- [CONFIRMED] `entity_refs` with `basis` and `method_version` both non-null: 14,305 (of 17,206 rows; the other 2,901 are the earlier unmined rows). By ref_table: section_claim_provenance 8,592; obligation_objects 3,146; grid_connection_queues 1,934; item_forward_events 187; regional_data_facts 275; state_cost_facts 92; statutory_computations 46; emission_factors 13; oem_tech_roadmaps 11; market_series 6; reroute_events 3.
- [CONFIRMED] `entity_relations`: 48 (all `asserted_by = coupling/seed`; the 57 relations of couplings.json minus those whose couplings were refused).
- [CONFIRMED] `derived_values` by pattern method: pattern_velocity_burst 19 (lifecycle emerging, method version 1.1.0); pattern_mandate_capacity, pattern_lead_lag, pattern_cross_modal, pattern_penalty_abatement 0. `derivation_edges` into them: 843.
- [CONFIRMED] Claim resolution after mining, the R3 population (non-GAP claims of items added in the last 270 days, 22,945): 5,985 reach at least one entity, 26.09 %. R3's emulation said 24.19 %. All 34,037 claims: 6,391, 18.78 %.

### Patterns found: 19 against an expected 0

R3 predicted 0 for every detector; the run found 19 for P1 and 0 for P2 to P5. [CONFIRMED] the difference is the real mining against the emulation: R3 judged a window claim to have one tier and one surface, and the detector's distinct test is max(tier count, surface count) >= 2, which a second surface (research, market, operations) in the window meets. The P2 to P5 zeros stand for the reasons R3 gives (those joins still wait on `target_year`, `queue_months_p50`, an entity on the research assessments and an EUR/tCO2e cost).

All 19 rows (the sample asked for is 20; there are 19), window 90 days, baseline 180 days, evidence capped at 50 members each:

| entity | kind | share ratio | admissibility | window claims | baseline claims | surfaces in the evidence | sources in evidence |
|---|---|---|---|---|---|---|---|
| LU | jurisdiction | 29.59 | analysis_ok | 104 | 3 | regulations+research | 30 |
| eur-lex.europa.eu | organisation | 20.58 | analysis_ok | 1,061 | 44 | regulations | 3 |
| 32008L0068 | instrument | 20.20 | analysis_ok | 71 | 3 | regulations | 18 |
| EU | jurisdiction | 15.09 | analysis_ok | 725 | 41 | regulations | 5 |
| HR | jurisdiction | 13.23 | analysis_ok | 62 | 4 | regulations | 15 |
| IT | jurisdiction | 11.10 | analysis_ok | 52 | 4 | regulations | 15 |
| CH | jurisdiction | 9.50 | display_only | 89 | 8 | regulations+research | 16 |
| AT | jurisdiction | 9.39 | analysis_ok | 44 | 4 | regulations+research | 13 |
| ES | jurisdiction | 8.11 | analysis_ok | 38 | 4 | regulations+research | 10 |
| BE | jurisdiction | 6.61 | display_only | 62 | 8 | market+regulations | 8 |
| GB | jurisdiction | 5.69 | analysis_ok | 80 | 12 | regulations | 11 |
| IE | jurisdiction | 5.43 | analysis_ok | 70 | 11 | regulations | 6 |
| DK | jurisdiction | 5.24 | analysis_ok | 43 | 7 | regulations | 9 |
| FI | jurisdiction | 4.91 | analysis_ok | 23 | 4 | operations+regulations | 7 |
| FR | jurisdiction | 4.61 | analysis_ok | 54 | 10 | market+regulations | 17 |
| IS | jurisdiction | 2.67 | analysis_ok | 25 | 8 | regulations | 12 |
| PL | jurisdiction | 2.19 | analysis_ok | 36 | 14 | regulations | 13 |
| 32015R0757 | instrument | 1.83 | analysis_ok | 15 | 7 | regulations | 6 |
| DE | jurisdiction | 1.51 | analysis_ok | 69 | 39 | regulations+research | 8 |

(Window and baseline counts are the key edge's summary; the surfaces and sources columns are of the capped evidence rows, so a pattern whose second surface lies outside the 50 shown reads one surface here.)

### Findings this measurement adds

1. [CONFIRMED] by a read of the evidence rows and the mining basis: the entities are real name matches (the bases read `how: name` with spans on Italy, Iceland, Luxembourg), so the resolver is not false-matching two-letter codes. Two of the 19 are noise on their face: LU, where 2 of 3 sampled basis rows are the signing-place formula "Done at Luxembourg" (the place of signature, not a subject), and eur-lex.europa.eu, the publisher host of every regulations source, which is not a subject any customer acts on. That is 2 of 19 (10.5 %) judged noise by the lane from the evidence rows; 17 are not judged noise.
2. [CONFIRMED] the corpus was added in bulk: items per `added_date` month are 83, 5, 32, 205, 1, 13, 632, 1,704 (Feb to Sep 2026), so the 90-day window (from 27 July) holds the August and September batches and the 180-day baseline holds the Feb to July months. [HYPOTHESIS, unverified] a share-of-flow burst between two intake batches measures the composition of the batches (EUR-Lex jurisdictional acts) rather than the world's attention, which would make most of the 16 jurisdiction rows an intake artefact. The test that settles it: re-run P1 with the window and baseline measured on the date of the cited source (capture date or the act's own date) instead of the item's `added_date`; if the 19 collapse, the detector needs that change, a producer-side finding, not a threshold edit.
3. [CONFIRMED] the ledger row of patterns-apply reads outcome `noop` while it wrote 19 `derived_values` and 843 `derivation_edges`. [HYPOTHESIS, unverified] the recorder derives the outcome from count keys ending in written/inserted/minted/raised/closed and the pattern counts are named `patterns_new`; the test is to read the recorder's classification and run a fixture turn with a pattern. Owner: the connect stage and the recorder (INTERFACE GAP, no edit made here).
4. [CONFIRMED] couplings-apply is `partial` for a stated reason: 11 of the 30 seed pages did not capture (`capture_thin` on four transport.ec.europa.eu pages, `robots_deferred` on imo.org, and others the ledger note truncates), so 6 of 47 couplings were refused and their relations not written (48 of 57). The refusals close when those pages capture through the browser tier; the plan can be re-run under a new revision once that is fixed.

## R5: the three defects of R4 tested, fixed and the plan run again (2026-10-26, production project kwrsbpiseruzbfwjpvsp, FIX-P1-1 merged as a77624d, plan revision 2, main run 40251087309)

Status tokens: rule 14.

| step | ledger run id | family | mode | outcome | what it counted |
|---|---|---|---|---|---|
| couplings-dry | f5eb4fb7-54c9-488f-b3af-7c70c78c9380 | propagation | dry | success | nothing written |
| couplings-apply | 3f880c3b-33e3-4fa9-8c2d-a1161e356cab | propagation | apply | partial | 30 seed pages cited: 9 captured, 19 unchanged, 2 failed (both imo.org); 1 coupling refused (node:bunkering); 3 entities, 13 aliases, 8 relations, 43 refs written; 40 events drained |
| patterns-dry | 7ea0a548-b06e-4cf4-b8a8-76eb5443c38d | corpus-turn | dry | success | nothing written |
| patterns-apply | 88e92120-af0f-435b-8a43-3754739c900f | corpus-turn | apply | success | 20 patterns: 1 new, 19 unchanged; refs_read 14,348, relations_read 56 |

### Defect 1 (P1 windows on the intake date): [REFUTED] on the only source date the provenance carries
- [CONFIRMED] method: the production P1 computation was re-run read-only with the real loader and detector. The run on the current clock (item `added_date`) reproduces the 19 patterns. The window, baseline and corpus flow were then moved to the capture's retrieved_at: `agent_run_searches.searched_at`, reached through `section_claim_provenance.search_result_id`. The provenance carries no published date.
- [CONFIRMED] result: 16 of the 19 survive with claims lacking a capture dropped (5,737 of 6,391 claim facts carry one); 19 of 19 survive when those claims fall back to the item day. The detector, its config and the method version are unchanged (`pattern_velocity_burst` stays 1.1.0).
- [HYPOTHESIS] the survival does not show the bursts are world signal: retrieved_at is itself an intake-time clock (every capture a claim rests on dates from 2026-06-02 to 2026-09-04). A date from inside the cited document (the act's own date, the page's published date) would settle it; no column carries one. Recorded on the FIX-P1-1 report as an improvement, not built.

### Defect 2 (the recorder read noop over writes): [CONFIRMED] cause, fixed
- [CONFIRMED] by code read: `classify` (src/core/harness/outcome.ts:32-38) sums only the keys the family declares in `src/core/harness/data/families.json` `writes`. corpus-turn declared none of the pattern keys, so run 64a761a9 (19 patterns, 843 evidence edges) read noop. The suffix rule in connect.ts:18 that R4 named only totals the term pass. R4's hypothesis named the wrong place.
- [CONFIRMED] the same class on production rows: 16 brief-apply rows recorded noop while rewriting items and lines (retokenise); 6 producer runs recorded noop while writing assessments, entities and refs. Keys added: corpus-turn patterns_new, patterns_superseded, patterns_obsolete, deadlines_synced, triggers_resolved; propagation seed_entities_written, seed_aliases_written, seed_relations_written, refs_written, seed_capture_captured, producers_capture_captured; brief-apply items_rewritten, lines_rewritten; producers written, entities_written, refs_written, signposts_written, edges_authored.
- [CONFIRMED] after the fix patterns-apply (88e92120) is `success` with 1 pattern written and 19 unchanged.

### Defect 3 (seed pages): [CONFIRMED] cause, fixed
| page | direct tier | browser tier | after the fix |
|---|---|---|---|
| 9 ec.europa.eu pages (transport x4, energy, environment, taxation-customs, commission, climate) | capture_thin | read the page (5,140 to 20,674 characters), refused by the classifier | captured or unchanged by the direct tier; every cited quote stands verbatim |
| imo.org (2 pages) | robots_deferred | robots_unknown | still failed: a stated absence, not worked around |

- [CONFIRMED] cause: classifyBody's EUR-Lex interface-shell rule (portal words such as "Select your language" with no instrument body) was handed no host by the capture path, so it applied to every host and fired on every europa.eu page. Reproduced on a rendered page with and without the host. Fix: the fetching sites pass the host and path (`bodyOpts`).
- Production read-back: seed pages with a stored capture 28 of 30; couplings refused 1 of 47 (node:bunkering, whose page is imo.org); `entity_relations` 56 (48 before); `entity_refs` with a basis 14,348 (14,305 before).

### derived_values by method after the run
pattern_velocity_burst 1.1.0: 20 emerging, 0 superseded; pattern_mandate_capacity, pattern_lead_lag, pattern_cross_modal, pattern_penalty_abatement: 0. `derivation_edges` into live patterns: 894. 1.2.0: none (the detector was not changed).

### The 20 surviving patterns (all of them; window 90 days, baseline 180 days)
The 19 of R4 are unchanged; one is new (32018L2001, the Renewable Energy Directive, whose page now grounds its coupling).

| entity | kind | share ratio | admissibility | window claims | baseline claims | surfaces in evidence | edges |
|---|---|---|---|---|---|---|---|
| LU | jurisdiction | 29.59 | analysis_ok | 104 | 3 | 2 | 51 |
| eur-lex.europa.eu | organisation | 20.58 | analysis_ok | 1,061 | 44 | 1 | 51 |
| 32008L0068 | instrument | 20.20 | analysis_ok | 71 | 3 | 1 | 51 |
| EU | jurisdiction | 15.09 | analysis_ok | 725 | 41 | 1 | 51 |
| HR | jurisdiction | 13.23 | analysis_ok | 62 | 4 | 1 | 51 |
| IT | jurisdiction | 11.10 | analysis_ok | 52 | 4 | 1 | 51 |
| CH | jurisdiction | 9.50 | display_only | 89 | 8 | 2 | 51 |
| AT | jurisdiction | 9.39 | analysis_ok | 44 | 4 | 2 | 45 |
| ES | jurisdiction | 8.11 | analysis_ok | 38 | 4 | 2 | 39 |
| BE | jurisdiction | 6.61 | display_only | 62 | 8 | 2 | 51 |
| GB | jurisdiction | 5.69 | analysis_ok | 80 | 12 | 1 | 51 |
| IE | jurisdiction | 5.43 | analysis_ok | 70 | 11 | 1 | 51 |
| DK | jurisdiction | 5.24 | analysis_ok | 43 | 7 | 1 | 44 |
| FI | jurisdiction | 4.91 | analysis_ok | 23 | 4 | 2 | 24 |
| FR | jurisdiction | 4.61 | analysis_ok | 54 | 10 | 2 | 51 |
| 32018L2001 | instrument | 4.52 | analysis_ok | 53 | 10 | 1 | 51 |
| IS | jurisdiction | 2.67 | analysis_ok | 25 | 8 | 1 | 26 |
| PL | jurisdiction | 2.19 | analysis_ok | 36 | 14 | 1 | 37 |
| 32015R0757 | instrument | 1.83 | analysis_ok | 15 | 7 | 1 | 16 |
| DE | jurisdiction | 1.51 | analysis_ok | 69 | 39 | 2 | 51 |

(Evidence is capped at 50 members plus one summary edge, so a pattern whose second surface lies beyond the 50 shown reads one surface here.) R4's judgement stands for the two noise rows (LU, signed-at wording; eur-lex.europa.eu, the publisher host): [CONFIRMED] by the evidence rows in R4, not yet excluded by a rule.
