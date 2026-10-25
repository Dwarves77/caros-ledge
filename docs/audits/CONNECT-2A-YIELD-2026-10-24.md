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
| P1 velocity | 1 | 1 row below | 0 of 1 judged noise | merged to fire after the thresholds were re-derived; the first pass fired 6 and 5 were noise |
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
