# item-briefs: a session's full-brief batch for record-grade items

A record-grade item holds only the facts the mint lifted from its capture. A session reads the item's stored pool, writes the full brief, its metadata and its claim ledger, and the kit validates the whole batch against the live pool before anything is written. Nothing is sent to a model; the session is the author.

## Export, author, apply

1. Export (read only, to a scratch directory outside the repository):
   `node scripts/turn.mjs --stage briefs --mode apply --input '{"briefs":{"export":{"kind":"item-briefs","outDir":"<dir outside the repo>","limit":40}}}'`
   Add `"ids":["<uuid>", ...]` to reach named items, including a quarantined one (a quarantined item is resolved, never left); an id that cannot be exported is named with its reason (`archived`, `not_found`) in each part's `residue`. Without `ids` the export is the next verified record-grade items in id order.
2. Read each part file's `items` (the item's joined material is in the bundle: `obligation_objects`, `scores` (priority, severity, urgency tier and the impact scores), `sources` with their tiers and `bias_tags`, `authoring_skills` (the writer skill of the item's format first), `candidate_entities` (the entity menu the typed blocks file under), the `pool` entries with their `capture_id`, and `packets`, the pattern packet of every derived pattern the item is a member of, so the relationship sections are written from joined tables, never from the item alone; the part's `summary` carries the workspace role vocabulary and states, in `packets`, what the packets door could not serve; a section that needs a packet then carries the skill's omission note): `pool` is the ONLY text you may cite, `source_pool_hash` is echoed back unchanged, `required_slots` lists each slot with its description, `forward_events` and `timelines` must reach the brief, `claims` and `sections` are what the item already holds.
3. Write the batch file and apply it: `--input` carries the file text as `batch.content` (for example `jq -n --rawfile c batch.json '{briefs:{batch:{kind:"item-briefs",content:$c}}}'`). Run it dry first (`--mode dry`): the answer lists every refusal and writes nothing.

```json
{ "batch": "item-briefs-001", "generated_at": "<ISO>", "authored_by": "session-lane",
  "entries": [ { "item_id": "<uuid>", "source_pool_hash": "<echo>", "body": "<markdown>",
    "metadata": { "<the 26-field contract, core/brief>": "..." },
    "claims": [ { "section": "<canonical key of the format, e.g. 8>", "claim_kind": "FACT", "claim_text": "[slot_key] <text>", "source_span": "<verbatim from the pool>", "source_url": "<pool url>", "slot_key": "binding_position" } ] } ] }
```

## The typed blocks (the reader's emission contract, DIGEST-1 PR B; kinds.json version 1.1.0)

Comprehension happens once, here, and is stored as typed values the flywheel joins on (ADR-053). Every block is optional per entry; every value that is present carries a quote `{ "capture_id": "<a pool capture_id>", "text": "<words from that capture>" }`. The quote is located in that capture of THIS item (any run of whitespace matches, so a list marker or a table cell can be quoted as one phrase); the capture's own slice is what is stored, and the exact verbatim rule runs on the slice. A quote that is not in the capture refuses the entry. Every value is stamped `reader@<kinds version>`.

The `candidate_entities` menu is the LIVE graph around the item, not a fixed list: the entities its own claims, events and obligations are filed under, one hop from them in `entity_relations`, those that share a formal code with them, and the entities its domain files most; each line carries its formal codes and aliases, and the block states what the cap dropped.

- `entity_ids`: `[ { "entity_id": "<id from candidate_entities.entities, or CELEX:<id>, UNLOCODE:<code>, ISO3166_1:<cc>, ISO3166_2:<code>>", "quote": {...} } ]`. File every entity on the menu that the text names (by name, alias or code); a mode or hub is written as its token `mode:ocean`. An id that is not on the menu and does not resolve from a formal code refuses the entry, naming the id. The menu is the item's own instrument, the entities its claims, events and obligations are typed-linked to, the closed ontology and the region and publisher; `truncated: n` says what the cap dropped.
- `obligation_fields`: `[ { "obligation_id" | "pinpoint": "...", "provision": {quote of the provision text}, "entity_ids": ["<menu ids>"], "fields": { "<column>": { "value": ..., "quote": {...} } } } ]`. Columns: `mode` (leg-mode tokens), `sanction_class` (the closed tokens), `statutory_maximum` and `cost_formula` (the figure exactly as the quote writes it), `enforcement_start`, `due_date` (add `"precision": "month"|"year"` beside `value` and `quote` when the source dates it only to a month or a year: the value is then the first of that month or 1 January, the quote states it at that precision, and the most precise date the quote states is the one you store; no precision means a day) (per object) and `in_force_end` (ISO dates the quote states), `mandated_quantity` (`{ "value": 50, "unit": "MW" }`, the quantity a mandate sets, never the penalty maximum; the unit is one `statutoryUnit` knows), and `duty_holder_class` (OPEN: one or more snake_case tokens such as `port_authority`; name the duty holder the quote names, any token the quote backs is valid), `binding_position`, `applicability_trigger` (`{ attribute, value }`), which a NEW object must carry. A reader value supersedes the derived value for the same column (the object becomes the next version); a derived value never overwrites a reader value.
- `connections`: `[ { "from_entity_id", "to_entity_id", "relation": "<a snake_case token; the usual ones: feedstock_of|fuel_for_mode|competes_for_feedstock|shares_grid_zone|serves_hub|corridor_links|implements|amends|consignment_wide>", "reason_token": "<snake_case>", "quote": {...} } ]`. The quote itself states why the two are connected; both ends are menu ids or mode tokens.
- `events`: `[ { "event_kind": "<entry_into_force|compliance_deadline|review_or_report|phase_step|consultation_close|target|implementing_act_due|delegated_act_due|guidance_expected|other>", "event_date": "YYYY-MM-DD", "quote": {...}, "mode": "ocean|air|road|rail|inland_waterway|multimodal", "entity_ids": [...] } ]`. The date is one the quote states. A maritime or aviation step carries its `mode`. A target or rulemaking date is never a deadline (ADR-051).
- `omitted_events`: `[ { "event_date": "YYYY-MM-DD", "reason": "<why the brief leaves it out>" } ]`. Every date in the bundle's `forward_events` and `timelines` must reach the brief: an `events` entry with that `event_date`, a section that states the date, or an `omitted_events` entry naming it with a non-blank reason. Otherwise the validator routes the entry to residue under `forward-events-covered`. Dates only; no wording is matched.
- `document_date`: `{ "date": "YYYY-MM-DD", "quote": {...} }`. It is written only where the producer could not read a dated line.
- `new_entity_candidates`: `[ { "proposed_kind": "organisation|technology|port|person", "canonical_name": "...", "quote": {...} } ]` for something the text names that is not on the menu. The name must occur inside its quote; a port whose quote carries a UN/LOCODE is written as `UNLOCODE:<code>` instead. `proposed_kind` is any snake_case token (organisation, technology, person, port, or a kind the text names, e.g. `vessel_class`). A candidate whose quote is verified is MINTED with the quote and the capture that name it, before anything else in the entry is written, and its id (shown in the validator's plan as `cl:<kind>:<hash of the normalised name>`) may be used in `entity_ids`, `connections`, `obligation_fields.entity_ids` and `events.entity_ids` of the same entry. The same name (normalised: case and spacing) is one id; a name an active entity of that kind already holds is reused, not minted again. An unverified quote mints nothing and a reference to its id is refused.

## The second reader (binary judges)

After the brief passes the deterministic rules, a second session answers each judge that applies, pass or fail with the evidence it rests on, and the entry carries them: `"review": { "reviewed_by": "<session>", "judges": { "J01": { "pass": true, "evidence": "<the sentence or row that decides it>" } } }`. The judges are in `src/core/digest/data/judges.json` (one prompt for one failure mode each); `requiredJudges` says which apply (by format, and by the typed block the entry carries). Every required judge must pass or the entry is residue naming the failed criterion; a missing verdict or a pass with no evidence counts as a fail.

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

## Metadata, forward events and filler (scope ruling 2026-10-26)

- Metadata is judged as body prose is: `what_is_it`, `what_it_changes` and `why_matters` fall under the same claim-scope (J24) and cause-effect (J05) rules as the body sections.
- Forward-event coverage (rule `forward-events-covered`): every exported `forward_events` or `timelines` row appears in the brief, by an `events` entry with its date or a section stating its stored date form, or carries an `omitted_events` entry with a reason. The brief also states which operational decision or exposure changes on that date (the second reader's J17 judges that half).
- No background filler under cost or feasibility headings (J06): regional macro statistics or generic background appear there only when the source ties the figure directly to the item's compliance cost or feasibility.

## What the apply does

Per item, in order: the brief (the injected-brief seam), the sections and timeline, the ground (the entry's ledger replaces the stub's claims, which are archived first; a verified item the database did not flip answers "already verified" and the step is reported failed, never quietly grounded), the cited sources registered and credited, `mentioned_terms` recorded, the structured actions written, then the flywheel participation (discovery, forward events and the compliance deadline, obligations, entities and lineage). A change is recorded once per (item, batch) when the item verifies. After the batch: tags, terms and the corpus pass over exactly the applied ids.

Budget and cooldown: an apply stops cleanly before the pool bytes it reads pass `options.ioBudgetMb` (default 400; 0 is unlimited) and resumes with `options.afterKey`; a previous apply that wrote holds the next off for 30 minutes (`options.cooldownMinutes`), read from the ledger. A re-apply of the same batch writes nothing new.
