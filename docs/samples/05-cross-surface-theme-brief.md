# Sample 05: cross-surface theme brief (shipping decarbonisation)

- Kind: `theme-briefs`
- Production record: connection_themes 7ae77ef8-211a-4f20-ad88-341c8dcdae65, 10 member items
- Produced: DIGEST-1 PR B Step B, 2026-10-26. The bundle was exported by the drain's own exporter over a read-only production client (a guard refuses every write verb and rpc); the entry below was authored by the build lane, a Sonnet session acting as the reader, from that bundle; it was then run through the drain's own apply path in dry mode (`applyBatch(..., dry: true)`).
- Dry-run outcome: valid 1, refused 0, residue 0 (dry, nothing written)
- Nothing was written to production. The second reader's verdicts were written by the same session that authored the entry, so they are not independent (see the validation note in `src/core/digest/data/judges.json`).

The theme's packet, read through the packets door (CONNECT-2 PR B's packets.ts), is empty today: no live pattern touches the theme's items (three P1 patterns are held back as undated or without a reader-asserted edge). The brief is therefore written from the theme bundle (the members' claims and forward events), and the no-single-source test runs over the rows it cites. When reader-asserted relations exist, the theme packet carries them.

## Authored brief

Title: Shipping decarbonisation: policy gap, buyer commitments and a fuel price shock

### connection

Ocean shipping decarbonisation is being set from three sides at once: a policy trajectory that remains well short, buyers committing to zero-emission fuel volumes, and fuel markets that are moving on supply shocks. [finding] CO₂ emissions from shipping are projected to land between 729–768 MtCO₂ in 2030, representing only a 1–6% decrease below the 2008 reference emissions level. Carriers and cargo owners have set their own marks: [conversion_trigger] Carriers: Power at least 5% of deep-sea shipping with zero-emission fuels by 2030. [conversion_trigger] Cargo owners: Internationally ship at least 10% of goods, in terms of volume, on ships using zero-emission fuels by 2030.

### meaning

A forwarder should read the policy gap and the buyer commitments together. The rating of current policy leaves the sector off its own path, while the coalition marks give carriers and cargo owners a date to plan against. [does_not_resolve] It is unclear how the postponement will affect the agreed technical measures of the NZF. *Analytical inference:* until the global rules are settled, the nearer pressure on carrier selection comes from buyer commitments and fuel costs, not from a single binding rule; this reading draws on the members cited here and is not stated in any one of them.

### ramifications

#### Regulations
Administrations, port authorities and other stakeholders as appropriate, are encouraged to provide incentives to ships rated as A or B. The rule text encourages incentives for well-rated ships; it does not set a duty for operators to choose them.

#### Market Intel
[driving_parties] QatarEnergy declared force majeure on March 4, which has forced Asian buyers who import over 80% of Qatari gas to compete for spot cargoes on global markets to replace lost contract volumes. [conversion_trigger] Cargo owners: Internationally ship at least 10% of goods, in terms of volume, on ships using zero-emission fuels by 2030.

#### Research
[signal_event] Fuels Goal: Enable the production of 16 Mt of heavy fuel oil equivalent (HFOe) well-to-wake zero-emission fuels by 2030. [finding] CO₂ emissions from shipping are projected to land between 729–768 MtCO₂ in 2030, representing only a 1–6% decrease below the 2008 reference emissions level.

### watch

Watch the carbon intensity target and the technical measures already agreed: 40% reduction in CO2 per transport work vs 2008 baseline (2023 IMO GHG Strategy)… [does_not_resolve] It is unclear how the postponement will affect the agreed technical measures of the NZF.

### gaps

No member sits in the home jurisdictions the workspace weights for the Union or aviation, and the lead research item has no operations counterpart. Coverage of shipping operations cost and port supply for this theme is absent from the members.

### Claims cited

- connection: member `c3fa4cc2`, claim `199ac670`
- connection: member `7ae77ef8`, claim `3c5fd91f`
- connection: member `7ae77ef8`, claim `2b84dacd`
- meaning: member `c3fa4cc2`, claim `a732531b`
- ramifications: member `a8cdaa93`, claim `1bebeed5`
- ramifications: member `b8da154a`, claim `423f3e80`
- ramifications: member `9baa3126`, claim `287a2017`
- ramifications: member `7ae77ef8`, claim `2b84dacd`
- ramifications: member `c3fa4cc2`, claim `199ac670`
- watch: member `a8cdaa93`, claim `7f5341da`
- watch: member `c3fa4cc2`, claim `a732531b`

## Second reader

Judges that applied: 11. Reviewer: session-lane (Sonnet 5.5) with judges.json 1.1.0.

First pass, before repair (the entry as first authored):

- J08 analysis-supported-by-facts: FAIL. Watch section: 'The review result decides whether the current efficiency measures are tightened' is not in any member's facts.
- J16 forward-statement-not-stale: FAIL. Watch section: 'A review shall be completed by 1 January 2026' is listed as an item to watch in a brief written 2026-10-26.

The entry below is the repaired version; the verdicts are on it.

| Judge | Criterion | Verdict | Evidence |
|---|---|---|---|
| J04 | four-lenses-served | pass | every lens the bundle supports is served and the absent lenses are acknowledged |
| J05 | cause-effect-sourced | pass | each cause and consequence is stated by a source sentence or labelled analysis |
| J06 | no-filler-no-invented-subsection | pass | every heading is in the format and every paragraph carries a sourced statement or the omission note |
| J07 | no-indirect-identification | pass | the text speaks to roles only |
| J08 | analysis-supported-by-facts | pass | each labelled analysis follows from the facts it cites |
| J12 | no-causation-from-correlation | pass | causal and headline statements are no stronger than the sources |
| J15 | no-invented-party-or-term | pass | every named party, figure and term of art appears in a bundle source |
| J16 | forward-statement-not-stale | pass | forward statements are ahead of the brief's date or stated as past |
| J17 | context-and-no-vacuum | pass | figures are placed against their context and forward events are stated |
| J23 | cross-surface-direction | pass | the finding's direction needs rows on two surfaces |
| J24 | claim-scope-not-widened | pass | each claim covers the source's own population, region, period and class |

## What this sample shows

- The first draft failed J16 (a review date of 1 January 2026 listed as something to watch in a brief written 2026-10-26) and J08 (a sentence about what the review result decides, which no member holds). The repair watches a 2030 target and the unresolved technical measures instead, both from the members.
- The no-single-source test (INV-DIG-7) is enforced mechanically: an earlier repair that cited only claim rows was refused as residue until a forward-event row was cited as well.
