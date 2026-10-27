# admin-opportunity-findings: the capital and bottleneck radar, for platform admins only

The live database graph is the ontology (operator rulings 2026-10-26). The export is one bundle per CLUSTER: a multi-angle neighbourhood of stored rows from the four surfaces, tied by a shared entity, relation hops, a scope window or a threshold. You define the patterns and the analysis from it. A mechanical detector no longer decides what you see; a current detector pattern whose evidence rows overlap the cluster rides in the bundle as one more input. Code verifies every row, entity, figure, date and quote you cite against the stored records.

## The bundle

- `cluster_id`, `anchor_entity_ids`, `hops`, `surfaces`, `angles`, `axes` (what joined the rows: `shared_entity`, `relation_hops`, `scope_window`, `threshold`).
- `rows[]`: `ref` (`table:pk`, the form a citation takes), `surface`, `entity_ids`, `date`, `figure` ({ value, unit } as stored), `quote_capture_id` and `quote_text` (the verbatim text of the row's capture, cut at `truncation.quote_chars_per_row`; `quote_truncated` says when). `truncation` states rows omitted by the cap.
- `detector_patterns[]`: a stored pattern over overlapping rows; a finding may cite one by `pattern_value_id`.
- The summary lists the lens and angle definitions, the source classes, the windows and the second reader's judges. A cluster already answered by a current finding is not exported, nor one waiting on a coverage gap it raised that is still open.

## Entry (one per cluster)

```json
{ "batch": "admin-opportunity-findings-001", "generated_at": "<ISO>", "authored_by": "session-lane",
  "entries": [ { "cluster_id": "<the bundle's id>",
    "patterns": [ { "ref": "p1", "kind": "<an angle token>", "rows_cited": [ { "table": "<t>", "pk": "<pk>" } ], "entity_ids": ["<optional, existing>"],
      "reasoning": [ { "cause": "<text>", "effect": "<text>", "row": { "table": "<t>", "pk": "<pk>" }, "quote": { "capture_id": "<the row's quote_capture_id>", "text": "<verbatim>" }, "figure": { "value": 0, "unit": "<as stored>" }, "date": "<as stored>" } ] } ],
    "findings": [ { "pattern_ref": "p1", "lens": "<one of three>", "window": "6-18m", "title": "<at most 160 characters>",
      "sourced_finding_md": "<only what the rows state, each statement ending with its [table:pk]>",
      "inferences": [ { "text": "<projection>", "status_token": "HYPOTHESIS", "basis": ["<table:pk>"] } ],
      "claim_provenance": [ { "row": "<table:pk>", "span": "<verbatim in that row's capture>" } ] } ],
    "tagged_inferences": [ { "text": "<a judgement across the cluster>", "status_token": "HYPOTHESIS", "basis": ["<table:pk>"] } ],
    "signposts": [ { "claim_text": "<what the pattern predicts>", "observable": "<one data point>", "source_class": "<class>", "confirms_if": "<result>", "falsified_if": "<a different result>", "by": "<future ISO date>" } ],
    "coverage_gaps": [ { "missing_input": "<the datum or instrument absent from the rows>", "source_class": "<class>" } ],
    "connections": [ { "from_entity_id": "<existing>", "to_entity_id": "<existing>", "relation": "<couplings relation>", "reason_token": "<snake_case>", "quote": { "capture_id": "<id>", "text": "<verbatim>" } } ],
    "review": { "reviewed_by": "<id>", "judges": { "<Jnn>": { "pass": true, "evidence": "<10 characters or more>" } } } } ] }
```

- Pattern `kind` is one of `mandate_vs_capacity`, `penalty_vs_abatement`, `cross_modal_competition`, `regulatory_stacking`, `lead_lag`, `maturity_vs_statute`. Any angle may be used on any cluster; `angles` in the bundle is a hint, not a gate.
- The reasoning is cause and effect at every link; every row in `rows_cited` is quoted by at least one link, and every link cites a row of `rows_cited` and a quote from that row's own capture. `figure` and `date` on a link must equal the stored value.
- `source_class` is an institution class of the host class table (`legalPrimary`, `legalPublisherAllow`, `govIntergov`, `intergovAnalysis`, `verifierCab`, `academicTld`, `associationAllow`, `standardsBodyAllow`, `lawfirm`, `news`, `analysis`, `big4Advisory`).
- Sourced finding versus tagged inference: a statement a row supports goes in `sourced_finding_md` with its `[table:pk]`; anything else is an inference tagged `CONFIRMED`, `HYPOTHESIS` or `REFUTED` and spoken as one. A projection is never written as a fact.
- The three lenses (the finding's `lens`): `supply_demand_bottleneck`, `penalty_abatement_crossover`, `capital_offtake_grant`. `window` is `0-6m`, `6-18m` or `18-36m`.
- A cluster you cannot read is answered with `coverage_gaps` alone: the missing input and the class of source that would hold it.

## What is verified (a failure refuses the entry and names the element)

A cited table and pk must be a row of the cluster and the table an admitted evidence table; an `entity_id` must exist and be active in `entities`; a `figure` or `date` must equal the stored value; a quote must be verbatim in the capture of the row it cites; a finding cites only cluster rows; a signpost's `by` must be in the future; a connection goes through the same validator as an item brief's (a relation of couplings.json, existing entities, a verbatim quote). The no-single-source test (rows from at least two tables and two surfaces) and the second reader make an entry residue with the reason, not a refusal.

## What is stored

- Each pattern: a `derived_values` row, method `pattern_ai_<angle>`, method_version `reader-synthesis@1.0.0`, lifecycle `emerging` (the current state), the cited rows as evidence edges, each carrying its reasoning link and quote in the input's `basis`. A pattern of the same cluster and angle it replaces is superseded.
- Findings: `admin_opportunity_findings` behind the platform-admin gate; an earlier finding of a replaced pattern is superseded.
- Signposts and tagged inferences: inference records (a signpost's ids in `admin_opportunity_findings.signpost_inference_ids`).
- Coverage gaps: queued as an open `integrity_flags` row of `holdings-need:synthesis-gap` with a `find-source` action carrying the source class, the cluster and the finding. The needs-search export reads it as a need; nothing is fetched (build mode holds the cadence off). A gap already queued is not queued twice; it gains the new raiser.
- Connections: `entity_relations`, through the item briefs' emission writer.

## The second reader

Judges that apply to this kind: J04 four-lenses-served, J05 cause-effect-sourced, J06 no-filler-no-invented-subsection, J07 no-indirect-identification, J08 analysis-supported-by-facts, J12 no-causation-from-correlation, J15 no-invented-party-or-term, J16 forward-statement-not-stale, J17 context-and-no-vacuum, J23 cross-surface-direction, J24 claim-scope-not-widened (prompts in `src/core/digest/data/judges.json`). J25 signpost-falsifiable-observable and J26 coverage-gap-names-missing-input are PROPOSED there (`proposed: true`): they are not required of any entry until their true positive and true negative rates are measured and the flag is removed.

## Before you freeze: effect wording, scope and the self-check (SYNTH-FIX-1)

Measured on the first admin and item batches: 0 of 8 findings and 0 of 18 briefs passed the second reader, all for the same four faults. Write against them.

- **A link's effect uses the source's own verb.** If the cited span says a rule "applies to" a party, the link says "applies to", not "raises its costs". An effect the span does not hold is an inference: label it (`*Analytical inference:*`, or an `inferences` entry with a status token) and cite the rows it rests on.
- **Scope is no wider than the span.** Say the jurisdiction, period, baseline and population of every figure; a limit the span states (an exclusion, a date range, a ship class, a region, "per year") travels with the figure. Whenever two figures are compared, state the jurisdiction, period and baseline of BOTH.
- **No figure is stated that the evidence does not hold.** Each figure with a recognised unit (or a percentage) in a finding, inference or signpost must be stated, as the same typed figure, in a cited row value or a cited capture (`figureCoverage`, the one comparator). A coverage gap is refused when it asks for a figure with its unit that a cited row or capture already states (`verifyWriteback`). Names, acronyms and domain terms are not word-matched: the second reader judges them and entity_refs structures them.
- **Self-check before freezing.** For every required judge of the kind (`src/core/digest/data/judges.json`), answer its text against your own entry, one judge at a time, and revise every failure; then freeze. Record the answers in `review_self` ({ "<judge id>": { "pass": true|false, "evidence": "<the sentence you checked>" } }, a judge that still fails after revision stays false). `review_self` is yours: the second reader ignores it and answers every judge afresh.
