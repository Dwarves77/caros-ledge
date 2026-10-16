# needs-search: source URLs for open needs

Four kinds of open flag name a source the system lacks: a term need (`term-need:`), a holdings need (`holdings-need:`), a flywheel gap (`flywheel-gap:`) and a lineage gap (`lineage-gap:absent-parent`). A session finds the publisher's own page for each; the system rates the source and feeds the mint.

## Export, author, apply

1. Export: `--input '{"briefs":{"export":{"kind":"needs-search","outDir":"<dir outside the repo>","limit":100}}}'`. Each need has `need_id`, `kind`, `text`, a `key` that survives the flag being re-raised under a new id, the `output` it feeds and what `satisfies` it. A need whose key was already served is not exported again.
2. Author `needs-search-NNN` (`authored_by` `session-lane`, at most 200 entries) and apply it as `batch.content`.

```json
{ "need_id": "<bundle>", "url": "<the publisher's own page>", "institution": "<name>", "why_authoritative": "<600 characters at most>", "confidence": 0.9,
  "host_verdict": { "host": "<the url's host>", "class": "<a class of the table>", "evidence": "<why>", "verdict_source": "session-lane", "generated_at": "<ISO>" } }
```

`host_verdict` appears only when the class table does not place the host.

## Rules (INV-209, CLAUDE.md rule 18)

- A batch names a SOURCE, never a tier. An entry with a `tier` is refused. The tier is the class table's for the url's host alone, or a host verdict for that exact host (a verdict names a class, never a tier number).
- An aggregator or hosting platform (a site that republishes someone else's text) is never registered, a verdict included: cite the publisher's own page.
- A source below the authority floor is rated and registered, not refused for being low.
- The url is http(s), without credentials, at most 2000 characters; the institution at most 200.

## What the apply does

Registers the source at the rated tier, creates the output the kind calls for (a `census_worklist` row born `would_mint` for term, holdings and gap needs: the mint's own screen, preflight and gates still decide; a `portal_link_candidates` row for a lineage parent: the ledger consume classifies it), and resolves the need with a marker the export reads back. The next intake picks both up. Every write is read back; a re-apply writes nothing new.
