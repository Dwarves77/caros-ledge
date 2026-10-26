# item-briefs: a session's full-brief batch for record-grade items

A record-grade item holds only the facts the mint lifted from its capture. A session reads the item's stored pool, writes the full brief, its metadata and its claim ledger, and the kit validates the whole batch against the live pool before anything is written. Nothing is sent to a model; the session is the author.

## Export, author, apply

1. Export (read only, to a scratch directory outside the repository):
   `node scripts/turn.mjs --stage briefs --mode apply --input '{"briefs":{"export":{"kind":"item-briefs","outDir":"<dir outside the repo>","limit":40}}}'`
   Add `"ids":["<uuid>", ...]` to reach named items, including a quarantined one (a quarantined item is resolved, never left); an id that cannot be exported is named with its reason (`archived`, `not_found`) in each part's `residue`. Without `ids` the export is the next verified record-grade items in id order.
2. Read each part file's `items` (the item's joined material is in the bundle: `obligation_objects`, `scores` (priority, severity, urgency tier and the impact scores), `sources` with their tiers and `bias_tags`, `authoring_skills` (the writer skill of the item's format first), and `packets`, the pattern packet of every derived pattern the item is a member of, so the relationship sections are written from joined tables, never from the item alone; the part's `summary` carries the workspace role vocabulary and says `packets: PENDING CONNECT-2 PR B` while the packets are not built, in which case a section that needs a packet is omitted with the skill's note): `pool` is the ONLY text you may cite, `source_pool_hash` is echoed back unchanged, `required_slots` lists each slot with its description, `forward_events` and `timelines` must reach the brief, `claims` and `sections` are what the item already holds.
3. Write the batch file and apply it: `--input` carries the file text as `batch.content` (for example `jq -n --rawfile c batch.json '{briefs:{batch:{kind:"item-briefs",content:$c}}}'`). Run it dry first (`--mode dry`): the answer lists every refusal and writes nothing.

```json
{ "batch": "item-briefs-001", "generated_at": "<ISO>", "authored_by": "session-lane",
  "entries": [ { "item_id": "<uuid>", "source_pool_hash": "<echo>", "body": "<markdown>",
    "metadata": { "<the 26-field contract, core/brief>": "..." },
    "claims": [ { "section": "<canonical key of the format, e.g. 8>", "claim_kind": "FACT", "claim_text": "[slot_key] <text>", "source_span": "<verbatim from the pool>", "source_url": "<pool url>", "slot_key": "binding_position" } ] } ] }
```

## What is refused, before any write (each reason names the item and the token or section)

- The file as a whole: a batch name that is not `item-briefs-...`, `authored_by` other than `session-lane`, a bad `generated_at`, `entries` not an array (nothing is applied).
- A stale pool (INV-207): `source_pool_hash` differs from the item's current pool. Re-export and re-author.
- An item at brief grade without `options.allowBriefOverwrite`.
- Body: under 600 characters, a fetch-failure explanation, a required slot the prose never addresses.
- Metadata that breaks the contract table (vocabularies, caps, locked severity and priority pairs).
- A claim without a `section`.
- The mirrors that stay at the entry (INV-211):
  1. Gate A: every figure and date in the body sits inside a FACT claim's text or span, or is not written.
  2. Criterion 4: a section that states a requirement (`requires`, `must`, `mandates`, `obligates`, `prohibits`, `applies to`) carries an analysis label or the legal callout in that same section.
  3. Timeline: the format's own timeline section yields at least one dated row (`- <date>: <label>`).
  4. Numeric figure: every figure in a claim's text also appears in that claim's own span (decimals kept; slot tags and legal locators ignored).
  5. Criterion 5: every required slot has a FACT claim whose text names the slot key, or a GAP only where the slot's description names a GAP form.
  (Claim section, depth accounting and qualification accounting are rules of the registry below.)

## The brief rules (src/core/brief/data/rules.json)

Thirty-two deterministic rules run on every entry, each a binary check named by its id. The registry row says what a violation does. A `refuse` violation (the rule would make a claim false or expose internals) refuses the entry with the rule id in each reason; the batch is held with its corrections file. A `residue` violation routes the entry to residue: it is not applied, the batch is not held, the reason in the residue row names the rule id, and the item stays a record stub that the next export lists again.

- Refuse: `dash-outside-verbatim` (an em or en dash in your own prose; text inside `«...»` and the `source_span` of a FACT claim are source wording and are never edited; a claim's own `claim_text` is your wording and is not exempt), `tier-phrase-exposure` (a T1 to T7 token or a source-tier phrase), `score-or-schema-token`, `fact-span-in-own-section` (a claim's `section` is a key of the format and holds its span), `no-claim-ledger-json` (an internal marker or a ledger key in the body), `fact-span-in-capture` (a FACT span verbatim, case-insensitive, in the item's pool).
- Residue: the workspace or a client named; a generic action phrase; a stored `entry_into_force` or `compliance_deadline` the body never writes; `what_it_changes` outside 80 to 200 characters; a do-now section without a severity label (`ACTION REQUIRED`, `COST ALERT`, `WINDOW CLOSING`, `COMPETITIVE EDGE`, `MONITORING`); an empty `sources_used`; an "as of" with no date; a missing required section; the depth and qualification accounting of a regulatory fact document (`accounting-line-present`); pipeline, pool or slot narration; a bare URL in prose; an HTML entity; "ibid"; a stray H1; a double hyphen or a section sign; a severity outside the five tokens (the stored form is the lowercase token, ADR-052), a missing severity, a priority that breaks the locked map, a banner that disagrees with the column; and the hygiene of `urgency_tier`, `why_matters`, `what_is_it`, `topic_tags`, `signal_band` and `theme`.
- Write the brief so the rules pass: the rule ids above are the reasons the apply gives, the phrase lists are in `src/core/brief/data/rule-patterns.json`, and `node scripts/ci/validator-report.mjs --fixture` shows each rule tripping on its planted sample.

A defective entry is refused alone, its reasons kept as residue; an entry a residue rule routes out is kept the same way; the valid entries still apply.

## What the apply does

Per item, in order: the brief (the injected-brief seam), the sections and timeline, the ground (the entry's ledger replaces the stub's claims, which are archived first; a verified item the database did not flip answers "already verified" and the step is reported failed, never quietly grounded), the cited sources registered and credited, `mentioned_terms` recorded, the structured actions written, then the flywheel participation (discovery, forward events and the compliance deadline, obligations, entities and lineage). A change is recorded once per (item, batch) when the item verifies. After the batch: tags, terms and the corpus pass over exactly the applied ids.

Budget and cooldown: an apply stops cleanly before the pool bytes it reads pass `options.ioBudgetMb` (default 400; 0 is unlimited) and resumes with `options.afterKey`; a previous apply that wrote holds the next off for 30 minutes (`options.cooldownMinutes`), read from the ledger. A re-apply of the same batch writes nothing new.
