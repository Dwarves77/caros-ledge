# host-verdicts: the class of a host the table cannot place

A host the built-in class table (src/core/sources) cannot place used to wait for a person to edit code. A session rules which class of the table the host belongs to, with the evidence; the kit validates the batch whole and each ruling lands in the host verdicts table, read back. The turn reads that table into the map every rating takes. The tier is read from the class, never written here.

## Export, author, apply

1. Export (read only, to a scratch directory outside the repository): `node scripts/turn.mjs --stage briefs --mode apply --input '{"briefs":{"export":{"kind":"host-verdicts","outDir":"<dir outside the repo>","limit":150}}}'`. Each item has the `host`, how often it was seen, the last name it appeared under and why it was left unplaced.
2. For each host, read the page title or self-description from the export and pick ONE class of the table. Write the title or description into `evidence`. A host you cannot place gets no entry; say so in the residue, never guess.
3. Author `host-verdicts-NNN.json` and apply it as `batch.content`:

```json
{ "batch": "host-verdicts-001", "generated_at": "<ISO>", "authored_by": "session-lane",
  "entries": [ { "host": "agency.example.org", "class": "association", "evidence": "<the page's own title or self-description>", "verdict_source": "session-lane", "generated_at": "<ISO>" } ] }
```

## Classes (the existing class table; a tier is never named)

legal, gov, verifier, academic, association, standards_body, analysis, lawfirm, news, company. An entry that names any other class, or carries a `tier` field, is refused.

## Rules

- A bare hostname only (no scheme, path or port).
- Aggregators and hosting platforms never register, a verdict included: the publisher's own page is cited.
- A verdict already stored with the same class is "already applied"; a later batch wins per host.
- A refused entry is kept as residue with its reason and the rest still apply.
