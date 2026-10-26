# admin-opportunity-findings: the capital and bottleneck radar, for platform admins only

A finding says where capital is legally or physically forced to flow next, months before the broader market, from a pattern the machine found across tables. The export is one bundle per derived pattern (a P2, P3 or P5 pattern, or a P1 or P4 pattern with a capital or capacity entity as a member), grouped by lens, each with its pattern packet: every member row with its typed columns, every verbatim claim span, the relations traversed, the evidence rows and the signposts already open. You may cite nothing outside the packet. The finding is stored behind the platform-admin gate and no customer route reads it.

**Status of this guide.** The batch below is what the author writes. The validator refuses a row outside the packet and a span the row does not offer; the no-single-source test and the second reader (`review`: `{ reviewed_by, judges }`, every judge that applies answered pass or fail with evidence) run before the apply writes the finding, registers its signposts and supersedes the pattern's earlier finding. The bundle carries `candidate_entities`, the menu of entities the packet's rows are filed under.

## The three lenses (the export groups by these; HOW-TO-LOOK point 5)

- `supply_demand_bottleneck`: a locked statutory demand ratchet against physical capacity (feedstock, grid, fleet, port) that cannot meet it on the date.
- `penalty_abatement_crossover`: the statutory penalty per tonne crossing or nearing the abatement cost of a technology or fuel at TRL 8 or above.
- `capital_offtake_grant`: filings, offtakes, capex and public grants that show where capital is forced to flow next.

`window` is the horizon the finding addresses, one of `0-6m`, `6-18m`, `18-36m`; state the horizon in the finding.

## Entry

```json
{ "batch": "admin-opportunity-findings-001", "generated_at": "<ISO>", "authored_by": "session-lane",
  "entries": [ { "pattern_value_id": "<the bundle's id>", "lens": "<one of the three>", "window": "6-18m", "title": "<at most 160 characters>",
    "sourced_finding_md": "<only what the packet's rows and spans state, each statement ending with its [table:row id]>",
    "inferences": [ { "text": "<a projection or judgement>", "status_token": "HYPOTHESIS", "basis": ["<packet row ids>"] } ],
    "signposts": [ { "claim_text": "<what would be seen>", "falsification_condition": "<what would show the finding wrong>", "by": "<date>" } ],
    "claim_provenance": [ { "row": "<table:id from the packet>", "span": "<verbatim from the packet>" } ] } ] }
```

## Rules

- Sourced finding versus tagged inference: a statement a packet row or span supports goes in `sourced_finding_md` with its row id. Anything else is an inference, tagged `CONFIRMED`, `HYPOTHESIS` or `REFUTED` (the inference record vocabulary) and spoken as one; a projection is never written as a fact (rule-no-speculation-as-fact).
- The no-single-source test (HOW-TO-LOOK point 3): the finding cites rows from at least two tables or surfaces, or it is residue with the reason.
- Every finding carries at least one falsifiable signpost: what would be seen, by when, and what would refute it. Generic advice ("monitor the market", "consider hedging") is not a finding.
- An id outside the packet is refused. A figure, date or unit not verbatim in a packet span is not written. Where the packet lacks an input, say which input and stop; do not fill it.
- Cause and effect at every link, each link sourced (rule-cause-and-effect-chain). Legal readings are labelled for counsel's confirmation (rule-no-regulatory-inferences-as-fact).
- Admin audience: the scoring recipe may be named, but nothing here is copied to a customer surface (rule-internal-vs-external-surface).
