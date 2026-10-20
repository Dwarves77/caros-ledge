# record-briefs: a session's full-brief batch for record-grade items

A record-grade item holds only the facts the mint lifted from its capture. A session reads the item's stored pool, writes the full brief, its metadata and its claim ledger, and the kit validates the whole batch against the live pool before anything is written. Nothing is sent to a model; the session is the author.

## Export, author, apply

1. Export (read only, to a scratch directory outside the repository):
   `node scripts/turn.mjs --stage briefs --mode apply --input '{"briefs":{"export":{"kind":"record-briefs","outDir":"<dir outside the repo>","limit":40}}}'`
   Add `"ids":["<uuid>", ...]` to reach named items, including a quarantined one (a quarantined item is resolved, never left); an id that cannot be exported is named with its reason (`archived`, `not_found`) in each part's `residue`. Without `ids` the export is the next verified record-grade items in id order.
2. Read each part file's `items`: `pool` is the ONLY text you may cite, `source_pool_hash` is echoed back unchanged, `required_slots` lists each slot with its description, `forward_events` and `timelines` must reach the brief, `claims` and `sections` are what the item already holds.
3. Write the batch file and apply it: `--input` carries the file text as `batch.content` (for example `jq -n --rawfile c batch.json '{briefs:{batch:{kind:"record-briefs",content:$c}}}'`). Run it dry first (`--mode dry`): the answer lists every refusal and writes nothing.

```json
{ "batch": "record-briefs-001", "generated_at": "<ISO>", "authored_by": "session-lane",
  "entries": [ { "item_id": "<uuid>", "source_pool_hash": "<echo>", "body": "<markdown>",
    "metadata": { "<the 26-field contract, core/brief>": "..." },
    "claims": [ { "section": "<canonical key of the format, e.g. 8>", "claim_kind": "FACT", "claim_text": "[slot_key] <text>", "source_span": "<verbatim from the pool>", "source_url": "<pool url>", "slot_key": "binding_position" } ] } ] }
```

## What is refused, before any write (each reason names the item and the token or section)

- The file as a whole: a batch name that is not `record-briefs-...`, `authored_by` other than `session-lane`, a bad `generated_at`, `entries` not an array (nothing is applied).
- A stale pool (INV-207): `source_pool_hash` differs from the item's current pool. Re-export and re-author.
- An item at brief grade without `options.allowBriefOverwrite`.
- Body: under 600 characters, a fetch-failure explanation, an internal marker, a required slot the prose never addresses.
- Metadata that breaks the contract table (vocabularies, caps, locked severity and priority pairs).
- A FACT whose `source_span` is not verbatim (case-insensitive) in the item's pool; a claim without a `section`.
- The eight mirrors (INV-211):
  1. Gate A: every figure and date in the body sits inside a FACT claim's text or span, or is not written.
  2. Criterion 4: a section that states a requirement (`requires`, `must`, `mandates`, `obligates`, `prohibits`, `applies to`) carries an analysis label or the legal callout in that same section.
  3. Timeline: the format's own timeline section yields at least one dated row (`- <date>: <label>`).
  4. Claim section: each claim's `section` is a key of the format and its span appears in that section's text.
  5. Depth accounting (`regulatory_fact_document`): `Substantive Requirements` ends with `Obligations surveyed: N; workspace-adjacent: M; extracted as FACT: K.`, K not above the FACT claims declaring that section, and a `Shortfall: <reason>` line when K < M or a pool over 200,000 characters yields K < 5.
  6. Qualification accounting: trajectory, exceptions and scope limits are each captured by an unnegated keyword in a FACT span of that section (or by `requirement_trajectory`), or recorded absent by `No phase-in is stated in Articles 1 to 4.`, `No exceptions are stated in ...`, `No scope limits are stated in ...`.
  7. Numeric figure: every figure in a claim's text also appears in that claim's own span (decimals kept; slot tags and legal locators ignored).
  8. Criterion 5: every required slot has a FACT claim whose text names the slot key, or a GAP only where the slot's description names a GAP form.

A defective entry is refused alone, its reasons kept as residue; the valid entries still apply.

## What the apply does

Per item, in order: the brief (the injected-brief seam), the sections and timeline, the ground (the entry's ledger replaces the stub's claims, which are archived first; a verified item the database did not flip answers "already verified" and the step is reported failed, never quietly grounded), the cited sources registered and credited, `mentioned_terms` recorded, the structured actions written, then the flywheel participation (discovery, forward events and the compliance deadline, obligations, entities and lineage). A change is recorded once per (item, batch) when the item verifies. After the batch: tags, terms and the corpus pass over exactly the applied ids.

Budget and cooldown: an apply stops cleanly before the pool bytes it reads pass `options.ioBudgetMb` (default 400; 0 is unlimited) and resumes with `options.afterKey`; a previous apply that wrote holds the next off for 30 minutes (`options.cooldownMinutes`), read from the ledger. A re-apply of the same batch writes nothing new.
