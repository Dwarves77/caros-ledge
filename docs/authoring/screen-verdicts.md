# screen-verdicts: rulings on the relevance screen's ambiguous holds

The mint's relevance screen holds a census row it cannot place as `screen:ambiguous:...`. A session rules each (IMP-039).

## Export, author, apply

1. Export: `--input '{"briefs":{"export":{"kind":"screen-verdicts","outDir":"<dir outside the repo>","limit":60}}}'`: the held rows (`census_id`, `title`, `document_url`, `hold_reason`). This is the judgement drain's own `screen-verdict` queue.
2. Apply `{ "verdicts": [ { "census_id": "<uuid>", "verdict": "on_vertical", "basis": "<the citation of why>", "reviewer": "<optional>" } ] }` as `batch.content`.

## Rules

`verdict` is `on_vertical`, `off_vertical` or `ambiguous`; `basis` is required (a ruling without its basis is refused); `census_id` is a uuid. A refused row is named and the rest still apply.

## What the apply does

Writes `screen_verdicts` (one row per census id, the last ruling wins), reads every row back, and re-admits to `would_mint` the held ambiguous rows that a stored verdict now rules on or off the vertical, so the mint re-screens them with the reviewed verdict. A verdict that stays `ambiguous` re-admits nothing; only the named census ids are ever reopened. A verdict already stored as written is "already applied": a re-apply writes nothing.
