# Sample 03: research summary (Climate Action Tracker, IMO policies)

- Kind: `item-briefs`
- Production record: intelligence_items c3fa4cc2-f168-4784-bf78-dda5c022843e, Climate Action Tracker page and a second capture
- Produced: DIGEST-1 PR B Step B, 2026-10-26. The bundle was exported by the drain's own exporter over a read-only production client (a guard refuses every write verb and rpc); the entry below was authored by the build lane, a Sonnet session acting as the reader, from that bundle; it was then run through the drain's own apply path in dry mode (`applyBatch(..., dry: true)`).
- Dry-run outcome: valid 1, refused 0, residue 0 (dry, nothing written)
- Nothing was written to production. The second reader's verdicts were written by the same session that authored the entry, so they are not independent (see the validation note in `src/core/digest/data/judges.json`).

## Authored brief

Format `research_summary`, severity MONITORING / LOW, urgency informational.

- what_is_it: A Climate Action Tracker assessment page on international shipping policy of the International Maritime Organization. It rates current policy projections for 2030 against 1.5 degree pathways and records the postponed vote on the Net Zero Framework.
- why_matters: The rating shows current ocean shipping policy leaves a large gap to 1.5 degree pathways, and the Net Zero Framework vote is postponed.
- what_it_changes: It records that the global shipping fuel standard and carbon price were not adopted and the vote is postponed to October 2026, so ocean planning should not assume them.

### 1. What the Research Found

Headline finding: With the current level of policy action, CO 2 emissions are projected to be between 729-768 MtCO 2 in 2030 (based on a voyage-based approach), only representing a 1-6% decrease below the reference emissions level in 2008. The CAT rates 2030 emissions under current policies as “Highly Insufficient.”

**Population:** international shipping. International shipping accounts for about 2.3% of global CO 2 emissions in 2023 (ICCT, 2025).

**Intervention:** the policy measures of the International Maritime Organization as they stand. The IMO failed to adopt the Net Zero Framework (NZF), a global fuel standard and carbon pricing mechanism, at the Marine Environment Protection Committee’s (MEPC) extraordinary session in October 2025.

**Comparator:** the reference emissions level in 2008 stated in the headline finding.

**Outcome:** a 1 to 6 percent decrease below the 2008 level in 2030 under current policy, in the headline finding above; the absolute figure is the range in MtCO 2 given there.

**Methodology in brief, scope and limitations:** These are the main policy measures underpinning the CAT’s current policy projections. The page is published on the Climate Action Tracker Home Global CAT Thermometer site. The rating remains unchanged from the previous assessment since no new policy measures have been adopted that would reduce emissions projections. Evidence grade: not assigned; the stored text holds no maturity assessment, and no inferred grade is given.

### 2. Why This Finding Matters Operationally and Commercially

Cause: The IMO failed to adopt the Net Zero Framework (NZF), a global fuel standard and carbon pricing mechanism, at the Marine Environment Protection Committee’s (MEPC) extraordinary session in October 2025.

Mechanical consequence: The most recent measures, Energy Efficiency of Existing Ship Index (EEXI) and the Carbon Intensity Indicator (CII), came into effect in January 2023, with the first ratings and reporting issued in 2024 (Infineum Insight, 2025). Ships rated E, or rated as D for three consecutive years, will need to develop a plan to increase their operational efficiency (DNV, 2023).

Effect by vertical: the page addresses international shipping as a whole and states no cargo-vertical effect; the effect on each vertical requires carrier-specific data. *Analytical inference:* ocean carriers on lanes with rated vessels may face vessel-level efficiency plans, which could reach charter selection; the page does not state this.

### 3. What the Finding Changes for Strategy, Claims, or Decisions

The finding limits one claim and supports a planning view. An operator cannot claim that international shipping policy is on track to its targets, because the page rates current policy as highly insufficient. The planning view: The tools and technologies for decarbonising the shipping sector are becoming increasingly accessible. *Analytical inference:* procurement of ocean capacity should test vessel carbon intensity ratings, because the page states the rating consequence in section 2.

### 4. Client Conversation Talking Points and Public Position

*No content for this section as of 2026-10-26: no client-facing position can be sourced beyond the claims in section 3.*

### 5. What the Finding Does Not Resolve

It is unclear how the postponement will affect the agreed technical measures. Dissent stated on the page: The near-term drop in CO 2 is due to fuel switching from heavy fuel oil (HFO) to LNG, which means that total GHG emissions are expected to be greater because of higher methane emissions.

Signpost: observe whether the Marine Environment Protection Committee adopts the Net Zero Framework when the vote returns, using the committee's session outcome.

- October 2026: Instead of abandoning the NZF, governments decided to postpone the vote to October 2026.

### 6. Sources

- Climate Action Tracker, IMO policies and action: https://climateactiontracker.org/sectors/shipping/imo-policies-action/

## Emitted typed blocks

### entity_ids

- `cl:organisation:b03e604ea31f565e` (organisation: imo.org)
  > The IMO is a UN special agency composed of 174 members states
- `cl:material:c8be4653bfad0c74` (material: Liquefied natural gas)
  > fuel switching from heavy fuel oil (HFO) to LNG
- `cl:material:4e3d861cf449961f` (material: Fossil residual fuel oil)
  > fuel switching from heavy fuel oil (HFO) to LNG
- `cl:method:bcd01a61afdbec3f` (method: ghg_intensity)
  > reduce the GHG intensity of shipping fuels over time

### obligation_fields

None emitted.

### connections

- material: Liquefied natural gas -- fuel_for_mode --> mode:ocean (reason `lng_powered_ships`)
  > the measures promote a switch to LNG-powered ships, resulting in greater GHG emissions

### events

None emitted.

### document_date

None emitted (the page states no date of its own).

### new_entity_candidates

- organisation: Marine Environment Protection Committee
  > Marine Environment Protection Committee’s (MEPC) extraordinary session

## Second reader

Judges that applied: 22. Reviewer: session-lane (Sonnet 5.5) with judges.json 1.1.0.

First pass, before repair (the entry as first authored):

- J18 entity-ids-complete: FAIL. The capture says 'reduce the GHG intensity of shipping fuels over time'; the ghg_intensity method (alias GHG intensity) is on the menu and not in entity_ids.

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
| J21 | pico-and-dissent-fidelity | pass | the research blocks state what the study states |
| J22 | conditional-section-has-grounded-claim | pass | conditional sections hold a grounded claim or only the omission note |
| J24 | claim-scope-not-widened | pass | each claim covers the source's own population, region, period and class |

## What this sample shows

- The one connection (LNG is fuel for ocean transport) carries a quote that states it ('the measures promote a switch to LNG-powered ships'); the second reader checks the quote, not the author's reasoning (J20).
- First draft failed J18: the capture says 'reduce the GHG intensity of shipping fuels over time' and the ghg_intensity method was on the candidate menu but not in entity_ids. The repair adds it with that quote.
- Research has no severity in the store: the entry carries MONITORING / LOW / informational, a gap recorded in the PR report.
