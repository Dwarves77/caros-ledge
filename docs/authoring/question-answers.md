# question-answers: a session's answers to open questions

A question is an open integrity flag under `question:` (one per item, surface and product question). An answer from holdings is an INFERENCE record, never a fact: it carries its status token, its cited items and its confidence, and is shown labelled as an inference (ADR-044). Nothing is sent to a model.

## Export, author, apply

1. Export: `--input '{"briefs":{"export":{"kind":"question-answers","outDir":"<dir outside the repo>","limit":100,"charBudget":60000}}}'`. One bundle per question: `subject_ref`, `pool_hash`, `question`, `needs` (`unanswered`, `reasked_after_new_holdings`, `reanswer_after_new_holdings`) and `items` (the question's item, then up to 8 connected items: typed edges first, then score), each with claims, forward events and the held `pool`. An item that is archived, not verified or sourced only from Community is never exported and never citable. A question whose outcome or answer was recorded against the SAME pool is not exported again.
2. Author the batch from the bundle (`question-answers-NNN`, `authored_by` `session-lane`) and apply it as `batch.content`.

```json
{ "subject_ref": "<bundle>", "pool_hash": "<echo>", "outcome": "answered", "answer": "<text, 1500 characters at most>",
  "status_token": "HYPOTHESIS", "confidence": 0.6, "cited_item_ids": ["<id>"],
  "evidence": [ { "item_id": "<id>", "claim_ids": ["<claim id>"], "source_span": "<20 to 600 characters, verbatim in that item's pool>" } ] }
{ "subject_ref": "<bundle>", "pool_hash": "<echo>", "outcome": "unanswerable_from_holdings", "missing": "<plain words: what kind of source about what would answer it>" }
```

## Rules

- `pool_hash` must equal the live held pool (INV-207); a changed pool re-opens a question for a re-answer, never for "unanswerable".
- `CONFIRMED` only when EVERY sentence of the answer is a quotation of an evidence span (INV-208): after whitespace collapse and lower-casing each sentence is a substring of some evidence span. A paraphrase is `HYPOTHESIS`. The token proves the words are the source's, not that they answer the question: that judgement is yours.
- Every number or acronym of three or more capitals in the answer appears in an evidence span, the question or a cited title. No ids in prose (cite items by title).
- `cited_item_ids` equals the set of evidence item ids; each claim id is a grounded FACT claim of the cited item; at most 8 evidence records.
- An unanswerable entry carries only `missing`.

## What the apply does

An answer writes ONE inference through the registration function (origin `derived`, `computed_by` `question-answers:<batch>`, the cited items as declared inputs, `supersedes` the prior inference when re-answering) and closes the question naming it and the pool it was answered against; nothing caches the item page, so the next read shows the answer. An unanswerable entry records the outcome on the flag, leaves it open and raises (or refreshes) ONE `holdings-need:` target the research walker and the needs-search export read; answering the question later closes the target. Every write is read back; a re-apply writes nothing new. A refused entry is residue with its reasons and never blocks the others.
