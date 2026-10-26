# Sample 04: operations profile (Japan, ports and LNG bunkering)

- Kind: `item-briefs`
- Production record: intelligence_items e9ed1215-57dc-4082-a28e-6c49673aabae, MLIT Ports and Harbours Bureau page and a trade news report
- Produced: DIGEST-1 PR B Step B, 2026-10-26. The bundle was exported by the drain's own exporter over a read-only production client (a guard refuses every write verb and rpc); the entry below was authored by the build lane, a Sonnet session acting as the reader, from that bundle; it was then run through the drain's own apply path in dry mode (`applyBatch(..., dry: true)`).
- Dry-run outcome: valid 1, refused 0, residue 0 (dry, nothing written)
- Nothing was written to production. The second reader's verdicts were written by the same session that authored the entry, so they are not independent (see the validation note in `src/core/digest/data/judges.json`).

## Authored brief

Format `operations_profile`, severity MONITORING / LOW, urgency stable.

- what_is_it: A Japan regional operations profile built from the Ports and Harbours Bureau page of the Ministry of Land, Infrastructure, Transport and Tourism and a trade news report on a joint logistics trial. It covers carbon neutral port policy, LNG bunkering and offshore wind port development.
- why_matters: Japanese ports run an LNG bunkering subsidy program and a carbon neutral port certification, which shape port choice for LNG-fuelled ocean tonnage.
- what_it_changes: Japanese ports offer LNG bunkering with a subsidy program and certification for carbon neutral terminals, so LNG-fuelled ocean tonnage can bunker there; no cost figures are stated.

### 1. Operational Cost Baseline for the Region

Jurisdiction: Japan. Starting in FY2018, a subsidy program was established for the development of facilities needed to form LNG bunkering hubs in Japanese ports, taking advantage of the country's position as the world's largest importer of LNG. Ports are hubs of international supply chains, with over 99% of import and export cargo passing through them.

Cost baseline: no sourced, dated cost figure for industrial electricity, fuel, labor, port handling or drayage is stated in the stored sources, so none is given. Current rate not publicly available in the stored sources.

### 2. Feasibility of Specific Operational Choices

LNG bunkering: possible. Starting in FY2018, a subsidy program was established for the development of facilities needed to form LNG bunkering hubs in Japanese ports, taking advantage of the country's position as the world's largest importer of LNG. For these projects, Japan's first Ship to Ship (STS) method of LNG bunkering was implemented in Ise and Mikawa Bays from October 2020. In FY2021, the LNG Bunkering Project in Kyushu and Setouchi Area based in Kitakyushu was adopted as the relevant subsidy program.

Shared truck logistics: possible on the evidence of a trial. The on-site trial in particular found striking results, including a 20 percentage point improvement in truck fill rate and a 28 percent reduction in CO2 emissions.

Cause: Starting in FY2018, a subsidy program was established for the development of facilities needed to form LNG bunkering hubs in Japanese ports, taking advantage of the country's position as the world's largest importer of LNG.

Mechanical consequence: *Analytical inference:* the subsidy program funds the facilities for the bunkering hubs, and the source reports the first Ship to Ship bunkering under these projects from October 2020; the source does not state that the subsidy produced it.

Project result: For these projects, Japan's first Ship to Ship (STS) method of LNG bunkering was implemented in Ise and Mikawa Bays from October 2020.

Effect by vertical: the sources state no cargo-vertical effect; the effect on each vertical needs carrier-specific data.

### 3. Cost Comparison Against Alternatives

*No content for this section as of 2026-10-26: the stored sources give no cost figure to compare.*

### 4. Cross-Regional Strategic Implications

*No content for this section as of 2026-10-26: the stored sources cover Japan only.*

### 5. Competitive Positioning in the Region

*No content for this section as of 2026-10-26: the stored sources name no competitor position.*

### 6. Client Conversation Talking Points

*No content for this section as of 2026-10-26: the stored sources support no cost or reliability claim for the region.*

### 7. Pending Changes That Shift the Calculus

Pending change: the Ministry of Land, Infrastructure, Transport and Tourism is promoting the Carbon Neutral Port (CNP) initiative that aims to enhance decarbonize terminal operation and develop an environment for receiving hydrogen, ammonia, etc. Further, Based on the discussions at the Council, the "Offshore Wind Industry Vision (1st)" was formulated in December 2020, which indicated that projects of 30 to 45 million kW would be formed by 2040.

- December 2020: Based on the discussions at the Council, the "Offshore Wind Industry Vision (1st)" was formulated in December 2020, which indicated that projects of 30 to 45 million kW would be formed by 2040.

### 8. Sources

- Ministry of Land, Infrastructure, Transport and Tourism, Ports and Harbours Bureau: https://www.mlit.go.jp/en/kowan/kowan_fr4_000011.html
- AlchemPro news desk, Japan trials joint logistics: https://www.alchempro.com/news/chemical-announcement-news/japan-trials-joint-logistics-to-tackle-transport-challenges--299892-newsdetails.htm

## Emitted typed blocks

### entity_ids

- `cl:node:45cf3c0145bb7adf` (node: Bunkering)
  > form LNG bunkering hubs in Japanese ports
- `cl:material:c8be4653bfad0c74` (material: Liquefied natural gas)
  > the world's largest importer of LNG

### obligation_fields

None emitted.

### connections

- material: Liquefied natural gas -- fuel_for_mode --> mode:ocean (reason `lng_fuelled_vessels`)
  > the number of vessels fueled by liquefied natural gas (LNG) is expected to increase

### events

None emitted.

### document_date

None emitted (the page states no date of its own).

### new_entity_candidates

- organisation: Ministry of Land, Infrastructure, Transport and Tourism
  > the Ministry of Land, Infrastructure, Transport and Tourism is promoting the Carbon Neutral Port (CNP) initiative that aims to enhance decarbonize terminal operation and develop an environment for receiving hydrogen, ammonia, etc.

## Second reader

Judges that applied: 21. Reviewer: session-lane (Sonnet 5.5) with judges.json 1.1.0.

First pass, before repair (the entry as first authored):

- J05 cause-effect-sourced: FAIL. Section 2 pairs the FY2018 subsidy program (cause) with the first STS bunkering in October 2020 (consequence); the source reports the STS bunkering as a project result without saying the subsidy produced it.
- J06 no-filler-no-invented-subsection: FAIL. Section 1 sentence 'Ports are therefore the point where a regional cost baseline would apply' is authored, supported by no source and gives the reader nothing to act on.

The entry below is the repaired version; the verdicts are on it.

| Judge | Criterion | Verdict | Evidence |
|---|---|---|---|
| J01 | severity-label-right | pass | the label matches the source facts under the four severity evaluation rules |
| J02 | do-now-action-specific | pass | the do-now text names a role, an object and a trigger, or asks for no action |
| J03 | three-ten-thirty-structure | pass | what_it_changes, why_matters and the first section state the change and the exposure the sources give |
| J04 | four-lenses-served | pass | every lens the bundle supports is served and the absent lenses are acknowledged |
| J05 | cause-effect-sourced | pass | each cause and consequence is stated by a source sentence or labelled analysis |
| J06 | no-filler-no-invented-subsection | pass | every heading is in the format and every paragraph carries a sourced statement or the omission note |
| J07 | no-indirect-identification | pass | the text speaks to roles only |
| J08 | analysis-supported-by-facts | pass | each labelled analysis follows from the facts it cites |
| J09 | prose-date-same-instrument | pass | each prose date belongs to the item's own instrument |
| J10 | quote-wording-not-authored | pass | no dash, entity or section sign outside verbatim quotes |
| J11 | vendor-claim-not-mandate | pass | requirements rest on the legislator's or regulator's text or are worded as reported claims |
| J12 | no-causation-from-correlation | pass | causal and headline statements are no stronger than the sources |
| J13 | legal-caveat-adequate | pass | each stated obligation carries a legal caveat naming what to confirm, or none is stated |
| J14 | tier-word-is-regulations-own | pass | the word tier does not appear, or is the regulation's own |
| J15 | no-invented-party-or-term | pass | every named party, figure and term of art appears in a bundle source |
| J16 | forward-statement-not-stale | pass | forward statements are ahead of the brief's date or stated as past |
| J17 | context-and-no-vacuum | pass | figures are placed against their context and forward events are stated |
| J18 | entity-ids-complete | pass | every menu entity the capture names in the item's subject is in entity_ids |
| J20 | connection-reason-in-quote | pass | each connection's quote states the relation between the two entities |
| J22 | conditional-section-has-grounded-claim | pass | conditional sections hold a grounded claim or only the omission note |
| J24 | claim-scope-not-widened | pass | each claim covers the source's own population, region, period and class |

## What this sample shows

- First draft failed J05 (the FY2018 subsidy as cause and the first ship-to-ship bunkering as consequence, which the source reports as a project result without saying the subsidy produced it) and J06 (an authored filler sentence). The repair labels the link as analysis, keeps the project result as a fact and removes the sentence.
- The Japan profile states no cost figure because no source in the bundle holds one; the cost sections carry the omission note instead of a number (no fabrication).
- Two menu entities appear only in a page sidebar and a related-article title; the second reader accepts their omission (J18), a boundary the prompt states.
