# Sample 01: regulatory fact document (Regulation (EU) No 530/2012, double-hull tankers)

- Kind: `item-briefs`
- Production record: intelligence_items b218c094-cb2b-4bea-9d00-ada2bbc12165, item_type regulation, EUR-Lex capture 763a8af3
- Produced: DIGEST-1 PR B Step B, 2026-10-26. The bundle was exported by the drain's own exporter over a read-only production client (a guard refuses every write verb and rpc); the entry below was authored by the build lane, a Sonnet session acting as the reader, from that bundle; it was then run through the drain's own apply path in dry mode (`applyBatch(..., dry: true)`).
- Dry-run outcome: valid 1, refused 0, residue 0 (dry, nothing written)
- Nothing was written to production. The second reader's verdicts were written by the same session that authored the entry, so they are not independent (see the validation note in `src/core/digest/data/judges.json`).

## Authored brief

Format `regulatory_fact_document`, severity MONITORING / LOW, urgency stable.

- what_is_it: A recast Regulation of the European Parliament and of the Council on the accelerated phasing-in of double-hull or equivalent design requirements for single-hull oil tankers, published in the Official Journal of the European Union and applicable in all Member States. It bars non-compliant oil tankers from Union flags and ports, and Member States notify the IMO of entry denials.
- why_matters: Oil and heavy grade oil cargoes into Union ports can only move on double-hull tonnage, so vessel choice is a booking condition.
- what_it_changes: Single-hull oil tankers may not call at Union ports or fly a Member State flag, so oil cargo bookings must be on double-hull tonnage and the vessel record must evidence it.

### 1. Purpose and Scope of This Document

This document covers REGULATION (EU) No 530/2012 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 13 June 2012 on the accelerated phasing-in of double-hull or equivalent design requirements for single-hull oil tankers (recast). It applies in the European Union. This Regulation shall be binding in its entirety and directly applicable in all Member States. *Legal Confirmation Required:* how it applies to a specific vessel or call is for counsel.

### 2. What This Regulation Is and Why It Applies to the Workspace

The purpose of this Regulation is to establish an accelerated phasing-in scheme for the application of the double-hull or equivalent design requirements of MARPOL 73/78, as defined in Article 3 of this Regulation, to single-hull oil tankers, and to ban the transport to or from ports of the Member States of heavy grade oil in single-hull oil tankers. This Regulation shall apply to oil tankers of 5 000 tonnes deadweight and above: (a) which fly the flag of a Member State; (b) irrespective of their flag, which enter or leave a port or offshore terminal or anchor in an area under the jurisdiction of a Member State. For operators of ocean freight, the Regulation sets a condition on the vessels a carrier may deploy to Union ports: a single-hull oil tanker is not a lawful call, whatever its flag.

*Operational implication:* operators chartering or contracting tonnage for oil and heavy grade oil cargoes into Union ports must confirm the hull design of each vessel before fixture.

### 3. Issues Requiring Immediate Action

MONITORING: no immediate action is required for operators whose oil cargoes already move on double-hull tonnage. The remaining decision is contractual: confirm that every voyage charter and carrier booking for oil cargo into a Union port states that the vessel is a double-hull oil tanker, because the competent authority of a Member State may, subject to national provisions, allow, under exceptional circumstances, an individual ship to enter or leave a port or offshore terminal or anchor in an area under the jurisdiction of that Member State, when: (a) an oil tanker is in difficulty and in search of a place of refuge; (b) an unloaded oil tanker is proceeding to a port of repair. Exceptions are discretionary, national and exceptional, so they cannot be planned around.

### 4. How the Workspace Sits in the Compliance Chain

The Regulation binds vessels, flag States and port States, and it places one explicit duty on Member States. Each Member State shall inform the IMO of its decision to deny entry to oil tankers, pursuant to Article 7 of this Regulation, operating in accordance with Regulation 20.5 of Annex I to MARPOL 73/78 into the ports or offshore terminals under its jurisdiction, on the basis of Regulation 20.8.2 of Annex I to MARPOL 73/78.

A forwarder or non-vessel operating carrier that books oil cargo is not named as a duty holder; the practical exposure is a booking that cannot be performed because the contracted vessel is refused entry. Legal Confirmation Required: whether a forwarder arranging a voyage charter carries any contractual liability for a refused vessel depends on the charter terms.

### 5. Authoritative Guidance Document Analysis

*No content for this section as of 2026-10-26: the stored source holds the Regulation text only and no authoritative guidance document.*

### 6. Anticipated Authoritative Guidance and Pending Regulatory Events

*No content for this section as of 2026-10-26: the stored source sets out no pending guidance or scheduled event.*

### 7. Threshold Questions

*No content for this section as of 2026-10-26: the stored source raises no unresolved threshold question.*

### 8. Substantive Requirements

### Double-hull requirement

Cause: No oil tanker shall be allowed to operate under the flag of a Member State, nor shall any oil tanker, irrespective of its flag, be allowed to enter into ports or offshore terminals under the jurisdiction of a Member State unless such tanker is a double-hull oil tanker.

Mechanical consequence: a vessel that is not a double-hull oil tanker cannot be flagged in a Member State or call at a Union port or offshore terminal.

Effect by vertical: the stored source states no cargo-vertical difference; effect on each cargo vertical requires carrier-specific data.

### Heavy grade oil

Cause: No oil tanker carrying heavy grade oil, irrespective of its flag, shall be allowed to enter or leave ports or offshore terminals or to anchor in areas under the jurisdiction of a Member State, unless such tanker is a double-hull oil tanker.

Mechanical consequence: the double-hull condition applies to heavy grade oil carriage in every case.

Effect by vertical: effect on each cargo vertical requires carrier-specific data.

### Condition Assessment Scheme

Cause: Irrespective of its flag, a single-hull oil tanker above 15 years of age shall not be allowed to enter or leave ports or offshore terminals or anchor in areas under the jurisdiction of a Member State unless such tanker complies with the Condition Assessment Scheme referred to in Article 6.

Mechanical consequence: an older single-hull tanker needs a compliant Condition Assessment Scheme record to call.

Effect by vertical: effect on each cargo vertical requires carrier-specific data.

### Final date

After the anniversary of the date of delivery of the ship in 2015, the following shall no longer be allowed: The two categories it names are Category 2 and Category 3 oil tankers operating under Regulation 20.5 of Annex I to MARPOL 73/78. The anniversary falls in 2015, so the date has passed.

*Legal Confirmation Required:* the application of the categories to a given vessel is for counsel and the flag State.

No phase-in is stated in Articles 4 to 7 beyond the final date above.
No exceptions are stated in Articles 4 to 7 other than those in Article 8, covered in section 12.
No scope limits are stated in Articles 1 to 3 other than the deadweight thresholds above.
Obligations surveyed: 4; workspace-adjacent: 3; extracted as FACT: 4.

### 9. Product-Specific Compliance Status

*No content for this section as of 2026-10-26: the Regulation concerns vessels, and no product-specific obligation is stated.*

### 10. Registration and Reporting Obligations

The only reporting duty in the stored source falls on Member States, not on operators. Each Member State shall inform the IMO of its decision to deny entry to oil tankers, pursuant to Article 7 of this Regulation, operating in accordance with Regulation 20.5 of Annex I to MARPOL 73/78 into the ports or offshore terminals under its jurisdiction, on the basis of Regulation 20.8.2 of Annex I to MARPOL 73/78. No registration scheme for operators is stated.

### 11. Operational System Requirements

MONITORING: the Regulation asks operators for no system build. The operational baseline is a vessel-screening step in chartering: record the hull design and, for a single-hull vessel above 15 years of age, the Condition Assessment Scheme status, before a booking is confirmed. Gap: a chartering desk without a hull-design field in its vessel record cannot evidence the check.

### 12. Exemptions and Edge Cases

*Article 8 allows a competent authority, subject to national provisions and under exceptional circumstances, to admit an individual ship in difficulty or an unloaded tanker proceeding to repair; see section 3 for the text.*

### 13. Adjacent Industry Research and Alternatives

*No content for this section as of 2026-10-26: no adjacent research is held for this item.*

### 14. Confirmed Regulatory Timeline

- 13 June 2012: Done at Strasbourg, 13 June 2012.
- 20 July 2012: The power to adopt the delegated acts referred to in Article 10(1) shall be conferred on the Commission for a period of five years from 20 July 2012.
- 2015: After the anniversary of the date of delivery of the ship in 2015, the following shall no longer be allowed:
- Entry into force: This Regulation shall enter into force on the twentieth day following that of its publication in the Official Journal of the European Union .

### 15. Sources

- EUR-Lex, Official Journal text of the Regulation: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32012R0530

## Emitted typed blocks

### entity_ids

- `cl:instrument:63598429980c135e` (instrument: 32012R0530)
  > REGULATION (EU) No 530/2012 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL
- `cl:jurisdiction:9170a8b2fb3234ba` (jurisdiction: EU)
  > THE EUROPEAN PARLIAMENT AND THE COUNCIL OF THE EUROPEAN UNION
- `cl:material:4e3d861cf449961f` (material: Fossil residual fuel oil)
  > ‘fuel oil’ means heavy distillates of crude oil or residues therefrom or blends of such materials

### obligation_fields

- Obligation `cl:obligation:be3cb30228029d2d`: > Each Member State shall inform the IMO of its decision to deny entry to oil tankers, pursuant to Article 7 of this Regulation, operating in accordance with Regulation 20.5 of Annex I to MARPOL 73/78 into the ports or offshore terminals under its jurisdiction
  - duty_holder_class = `["member_state"]`
    > Each Member State shall inform the IMO
  - binding_position = `"direct_duty"`
    > Each Member State shall inform the IMO of its decision to deny entry to oil tankers
  - applicability_trigger = `{"attribute":"event","value":"decision to deny entry to oil tankers pursuant to Article 7"}`
    > its decision to deny entry to oil tankers, pursuant to Article 7 of this Regulation

### connections

None emitted.

### events

- 2012-07-20 `other` (mode ocean)
  > The power to adopt the delegated acts referred to in Article 10(1) shall be conferred on the Commission for a period of five years from 20 July 2012.

### document_date

- 2012-06-13
  > Done at Strasbourg, 13 June 2012.

### new_entity_candidates

- organisation: International Maritime Organisation
  > the International Maritime Organisation (IMO)

## Second reader

Judges that applied: 21. Reviewer: session-lane (Sonnet 5.5) with judges.json 1.1.0.

First pass, before repair (the entry as first authored):

- J19 obligation-field-quote-states-it: FAIL. duty_holder_class 'operator' is quoted from 'No oil tanker shall be allowed to operate under the flag of a Member State' (names a vessel), the applicability_trigger instrument_in_scope '32012R0530' is not in its quote, and mode 'ocean' on the Member State duty is quoted from 'ports or offshore terminals under the jurisdiction of a Member State'.

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
| J19 | obligation-field-quote-states-it | pass | duty holder, binding position and trigger quotes state their values: Each Member State shall inform the IMO; No oil tanker shall be allowed; oil tankers of 5 000 tonnes deadweight and above |
| J22 | conditional-section-has-grounded-claim | pass | conditional sections hold a grounded claim or only the omission note |
| J24 | claim-scope-not-widened | pass | each claim covers the source's own population, region, period and class |

## What this sample shows

- The second reader caught a real defect in the first draft: two obligation_fields whose quote did not state the value (J19). The repair dropped the one field the text cannot support: Article 4 prohibits a vessel class and names no duty holder, and a new obligation object needs a duty-holder class, so it cannot be emitted with a quote that states it (a design gap recorded in the PR report).
- The entities the text names in its own subject (the instrument, the Union, the heavy fuel oil definition) are in entity_ids with the quote that names them; the signature line "Done at Strasbourg" gives document_date with its verbatim quote.
- Every date in the prose is the Regulation's own; the delegated-acts date is emitted as an event of kind `other`, never as a deadline (ADR-051).
