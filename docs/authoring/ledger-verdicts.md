# ledger-verdicts: classification verdicts for the portal ledger

The portal link ledger lists deep links the sweeps found. A candidate with a session verdict is classified (is it a specific document, and which), minted at record grade through the one chokepoint and stamped; a candidate with none stays owed. Nothing is sent to a model.

## Export, author, apply

1. Export: `--input '{"briefs":{"export":{"kind":"ledger-verdicts","outDir":"<dir outside the repo>","limit":100}}}'`. Each candidate has `candidate_id`, `url`, `anchor_text`, the source's name, category and tier, and `text` (the page text, at most 6,000 characters) with `fetch_ok` and `fetch_error`. While the scrape gate is closed no page is fetched (`fetch_error`: `fetch held: the scrape gate is closed`). A row with `access_wall:<kind>`, `below_floor_200` or a failed fetch is not classify-ready: write NO verdict for it, and never guess one from the url. The summary carries the live `prompt_version` and the instruction.
2. Author the verdict file and apply it as `batch.content`:

```json
{ "batch": "ledger-verdicts-001", "generated_at": "<ISO>", "prompt_version": "<live>", "classified_by": "session-haiku",
  "entries": [ { "candidate_id": "<id>", "url": "<url>", "entity_verdict": "specific_document", "item_type": "regulation", "confidence": 0.9, "rationale": "<why>",
    "classified_by": "session-haiku", "classified_at": "<ISO>", "prompt_version": "<live>", "domain": 1, "severity": "MONITORING", "priority": "LOW", "urgency_tier": "stable",
    "title_candidate": "<title>", "summary": "<one line>", "surface_tags": ["regulations"], "relevance": 80 } ] }
```

`entity_verdict` is `specific_document`, `portal` or `uncertain`; `item_type` is null unless `specific_document`, which also needs `domain`, `severity`, `priority`, `urgency_tier` and `title_candidate`.

## Rules

A structurally malformed entry refuses the WHOLE file. An entry under another `prompt_version` is excluded and counted, never accepted: re-author it under the live version in a new file. The match key is the url; one verdict per url, the newest wins. An error-body page is never a document, whatever the url suggests.

## What the apply does

Runs the intake consume with exactly these verdicts: classify, dry mint, capped promote (`options.maxPromote`, default 50), stamp each candidate `promoted` or `rejected`, mint at record grade; the minted ids are on the run's row for the connect stage. A candidate without a verdict is counted `verdicts_owed`.
