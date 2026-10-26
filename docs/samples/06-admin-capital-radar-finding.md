# Sample 06: admin capital-radar finding (a production pattern whose join is a shared mode only)

- Kind: `admin-opportunity-findings`
- Production record: derived_values c20ac3dc-d13f-40e9-9d50-56d7984c0a1a, method pattern_mandate_capacity 1.2.0, lens supply_demand_bottleneck
- Produced: DIGEST-1 PR B Step B, 2026-10-26. The bundle was exported by the drain's own exporter over a read-only production client (a guard refuses every write verb and rpc); the entry below was authored by the build lane, a Sonnet session acting as the reader, from that bundle; it was then run through the drain's own apply path in dry mode (`applyBatch(..., dry: true)`).
- Dry-run outcome: residue 1: the second reader's J23 fails (dry, nothing written)
- Nothing was written to production. The second reader's verdicts were written by the same session that authored the entry, so they are not independent (see the validation note in `src/core/digest/data/judges.json`).

The pattern's packet (read through packets.ts) holds 32 member rows: the key row is an obligation object from the plastic pellet loss Regulation (Article 12, the packaging duty for pellets carried by sea in freight containers); the evidence row is an OEM roadmap (saf_refinery, mass_series_production, target year 2027). The pattern joins them on a shared transport mode. The other 30 rows are context from the same Regulation.

## Authored finding

Lens supply_demand_bottleneck, window 6-18m.

Title: SAF refinery capacity pattern rests on a packaging duty, not a mandated quantity: the bottleneck reading is not supported

The pattern pairs a mandate row with a capacity row. The mandate row is [obligation_objects:cl:obligation:5c11a2303a751d09]: it concerns the transport of plastic pellets by sea in freight containers and carries no mandated quantity. The capacity row is [oem_tech_roadmaps:70c8d5a8-4566-46bc-b13c-763872a1a2b0]: a saf_refinery roadmap at mass_series_production with target_year 2027. The application date in [item_forward_events:0171c07d-2024-4cea-854b-57869c11a7df] is 17 December 2027.

A supply-demand bottleneck needs a locked statutory demand ratchet against physical capacity. The packet holds no row that states a demand quantity, a blending share or a tonnage for the refinery's output. The two rows share a transport mode and a date window, and nothing else. The packet supports a capacity data point on SAF refineries; it does not support a bottleneck finding.

Inferences:

- REFUTED: The packet does not evidence a mandated demand ratchet against refinery capacity; the mandate row is a packaging duty. (basis: obligation_objects:cl:obligation:5c11a2303a751d09, oem_tech_roadmaps:70c8d5a8-4566-46bc-b13c-763872a1a2b0)
- HYPOTHESIS: The refinery roadmap target of 2027 and the 17 December 2027 application date fall in the same year, which is a coincidence of dates and not a demonstrated link. (basis: oem_tech_roadmaps:70c8d5a8-4566-46bc-b13c-763872a1a2b0, item_forward_events:0171c07d-2024-4cea-854b-57869c11a7df)

Signposts:

- A quantity mandate for fuel supplied to ocean or air transport links to the saf_refinery capacity row. Falsified if: no instrument in the packet or its linked entities states a mandated quantity or share by 2027-12-17. By 2027-12-17.

Claim provenance (each span is verbatim in its packet row):

- `obligation_objects:cl:obligation:5c11a2303a751d09`: > Obligations regarding the transport of plastic pellets by sea in freight containers
- `oem_tech_roadmaps:70c8d5a8-4566-46bc-b13c-763872a1a2b0`: > tech_category saf_refinery; commercial_stage mass_series_production; target_year 2027
- `item_forward_events:0171c07d-2024-4cea-854b-57869c11a7df`: > It shall apply from 17 December 2027.

## Second reader

Judges that applied: 11. Reviewer: session-lane (Sonnet 5.5) with judges.json 1.1.0.

First pass, before repair (the entry as first authored):

- J23 cross-surface-direction: FAIL. The finding states no direction: its own text says the packet has no quantity row and that the two rows share only a transport mode and a date window.

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
| J23 | cross-surface-direction | FAIL | The finding states no direction: its own text says the packet has no quantity row and that the two rows share only a transport mode and a date window. |
| J24 | claim-scope-not-widened | pass | each claim covers the source's own population, region, period and class |

## What this sample shows

- The finding passes the packet check (every cited id is in the packet, INV-CN2-4), the verbatim-span check and the no-single-source test (rows from three tables and two surfaces). It is still residue: J23 requires a direction that needs rows on two surfaces, and an honest reading of this packet gives none. The pattern is a spurious join, a producer defect to repair upstream (the mandate row states no quantity), not something the reader should paper over.
- This is the second reader doing its job on a real production pattern. The other exported pattern (8e1be168, an ammonia engine roadmap joined to the same pellet duty) has the same shape and the same outcome.
