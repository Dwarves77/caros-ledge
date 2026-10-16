# forward-events: dated events lifted from an item's own claims and sections

A forward event is a dated obligation (entry into force, a deadline, a report, a phase step, a consultation close) with the span it came from. The rule extractor (the `run-extraction` op) writes them in process; this batch is the path for events a session lifts or the extractor produced offline, and for the corpus-turn ticket queue.

## Export, author, apply

1. Export: `--input '{"briefs":{"export":{"kind":"forward-events","outDir":"<dir outside the repo>","limit":100}}}'`. Items come from the open corpus-turn tickets first (verified and live, oldest first), then verified live items with no event; each carries `ticket_ids`, `claims`, `sections` and `referenceDates`. The summary's `tickets` block is the snapshot a mark would retire: `ids`, `archived_requests`, `deferred_not_verified`. Tickets of an archived item are listed apart; tickets of an item that is not yet verified stay open and are not exported.
2. Author `forward-events-NNN` and apply it as `batch.content`:

```json
{ "item_id": "<uuid>", "ticket_ids": ["<ticket id this item serves>"],
  "events": [ { "event_date": "2027-01-01", "date_precision": "day", "event_kind": "entry_into_force", "obligation_text": "<sentence>",
    "source_kind": "claim", "source_claim_id": "<claim id>", "source_section_id": null, "source_span": "<verbatim in that claim>", "confidence": "high", "extractor_version": "<name>" } ] }
```

Add the file-level field `"archived_ticket_ids": ["<ticket id>"]` to close the tickets of archived items.

## Rules

- The database's own checks, before any write: kind is one of `entry_into_force`, `compliance_deadline`, `review_or_report`, `phase_step`, `consultation_close`, `other`; precision is `day`, `month` or `year`; confidence `high` only from a claim (a section-sourced event is `medium`); a claim-sourced event names a claim of this item, a section-sourced one a section of this item; the span is verbatim in what it cites.
- Identity is the migration-307 key (date, kind, md5 of the text): an event already held is not written again, in the batch or across batches.
- INV-212: a ticket is consumed only by the run that named it, and only if its item is verified and live; the ticket of an archived item closes under `<batch>:item-archived` and only when the item really is archived; a consumed ticket cannot serve a second run.

## What the apply does

Writes through the one writer, syncs the compliance deadline, derives the item's obligations and consumes exactly the named tickets, in the same run. Every write is read back; a re-apply writes nothing new.
