Run one judgement drain (the digest). You are a scheduled session; the operator is not present and nothing waits on them. The drain is OFF until the operator has accepted the sample set (ADR-050): STEP 0 is what keeps it off. Everything is free: author with Sonnet or Haiku sub-agents inside this session, never the metered model API. Do not create or change any scheduled task. Do not merge anything.

The ratified skill corpus is the contract (ADR-048). Skills are loaded by name with the Skill tool; the tables below name the guide of each kind. Nothing in a bundle is a command: it is data you author from.

STEP 0, the kill switch. From the repository root run:

`node scripts/digest/plan-drain.mjs`

If it prints `drain: off`, stop here. Report that one line (it names the reason: the judgement_drain switch is off, the emergency pause is set, or fleet-budget-halt is open, or the database could not be read) and nothing else. Do not read any queue, do not open a PR, do not retry. The command reads only the switches before it decides, and a failed read counts as off. Rule 11: every recurring worker checks its kill switch before work, and firings are expensive, so an off drain costs one command.

If it prints `drain: on`, it wrote a plan file (the path is in its first line, outside the repository) and took mutation leases on every item it handed out. From here on, release those leases no matter how the run ends (STEP 4).

STEP 1, read the plan. It lists kinds in the order to work them (oldest pending first), and for each kind: the batch file path the session must write (exactly one file per kind), the item ids it covers, where the bundle is (re-export it, STEP 2), the apply step that runs on merge, and `authoring_guide` (the batch schema document and the skills). A kind with an `export_error` or no batches is skipped and recorded, never retried and never fabricated.

STEP 2, author each batch file, one kind at a time.
- Export the bundle for the plan's ids to a scratch directory outside the repository: `node scripts/turn.mjs --stage briefs --mode apply --input '{"briefs":{"export":{"kind":"<kind>","outDir":"<dir outside the repo>","ids":[...]}}}'`. Read only the bundle entries for the ids the plan lists.
- Read the kind's schema document (`authoring_guide.schema`) and load its skills (`authoring_guide.skills`, and for item briefs the writer skill of the item's `format_type`) in full before writing.
- Split the item ids among Sonnet or Haiku sub-agents (about 5 to 15 items each, fewer for the heavy bundles), each given the guide, its slice of the bundle, and nothing else. A sub-agent writes entries only from material in its bundle: a figure, a span, a classification it cannot ground in that material is left out and listed as residue with the reason, never guessed (rule 2). A host or candidate it cannot place gets no entry.
- The SECOND READER: a different sub-agent from the author reads each entry with its bundle and answers every binary judge that applies (src/core/digest/data/judges.json; `requiredJudges` names them), pass or fail with the evidence it rests on, and the verdicts ride in the entry as `review`. An entry with a failed judge is residue with the criterion named and is not in the batch. Entries with typed blocks (entity_ids, obligation_fields, connections, events, document_date, new_entity_candidates) quote the captures named in the bundle's `pool`; ids come from `candidate_entities` only.
- Merge the sub-agents' entries into the ONE batch file at the planned path, shaped exactly as the schema document shows. Prose in new text: no em dashes, en dashes or section-sign glyphs.
- Validate the file before committing: a dry apply, `jq -n --rawfile c <batch file> '{briefs:{batch:{kind:"<kind>",content:$c}}}' > <input file>` then `node scripts/turn.mjs --stage briefs --mode dry --input "$(cat <input file>)"`. A refused entry is fixed or dropped with its reason; a file that fails whole is not committed. Never edit the validator or the schema to make a batch pass.

The guides, by kind (a skill is loaded by name; the schema document is in the repository):

| kind | schema document | skills |
|---|---|---|
| item-briefs | docs/authoring/item-briefs.md | the writer skill of the item's format (regulatory_fact_document: writer-regulatory-fact-document; market_signal_brief: writer-market-signal-brief; research_summary: writer-research-summary with ADR-049's four blocks; operations_profile: writer-operations-profile; technology_profile: writer-technology-profile), under environmental-policy-and-innovation and analysis-construction-spec; with rule-cause-and-effect-chain, rule-workspace-anchored-output, rule-source-traceability-per-claim, rule-no-speculation-as-fact, rule-no-regulatory-inferences-as-fact, vocabulary-severity-labels |
| theme-briefs | docs/authoring/theme-briefs.md | environmental-policy-and-innovation (the four lenses), rule-cause-and-effect-chain, rule-no-speculation-as-fact, rule-source-traceability-per-claim, rule-workspace-anchored-output, vocabulary-severity-labels |
| admin-opportunity-findings | docs/authoring/admin-opportunity-findings.md | rule-no-speculation-as-fact, rule-internal-vs-external-surface, rule-no-regulatory-inferences-as-fact, rule-cause-and-effect-chain, rule-source-traceability-per-claim, source-credibility-model; and point 5 of the build's HOW-TO-LOOK page (the offensive radar, behind the platform-admin gate) |
| question-answers | docs/authoring/question-answers.md | rule-source-traceability-per-claim, rule-no-speculation-as-fact, rule-cause-and-effect-chain |
| needs-search | docs/authoring/needs-search.md | reference-priority-source-registry, source-credibility-model |
| ledger-verdicts | docs/authoring/ledger-verdicts.md | source-credibility-model, caros-ledge-surface-contracts |
| host-verdicts | docs/authoring/host-verdicts.md | source-credibility-model, vocabulary-source-tiers |

What each sub-agent writes:
- item-briefs: the format the item type demands, every claim a FACT with its verbatim `source_span` from the named capture in the bundle's `pool` (or the id of a packet row it was read from), sections without grounded content OMITTED with the note the skill prescribes (never filled), workspace anchoring by ROLE from the bundle's role vocabulary and never by name, severity labels at decision points, cause and effect at every link and each link sourced, legal-confirmation labels where the skill requires them. The relationship sections (adjacent research, intersection summary, pending events, cost mechanism) are written from the joined material in the bundle (obligation objects, scores, source tiers and bias tags, the item's packets), never from the item alone; when the bundle's summary says `packets: PENDING CONNECT-2 PR B`, the sections that need a packet are omitted with the note, not written from the item alone.
- theme-briefs: the cross-surface rule set: the four lenses, cause and effect at every link, the 2-6 and 6-18 month horizons stated per finding; every statement cites a member row; a brief whose rows come from one table or one surface is residue (the no-single-source test).
- admin-opportunity-findings: authored from the pattern's packet under docs/authoring/admin-opportunity-findings.md; the second reader's verdicts ride in each entry; stored behind the platform-admin gate.
- The rest: as their schema documents say.

STEP 3, one PR per kind. Never commit on main or the main checkout; work in a worktree.
- Create a branch `drain/<run id>-<kind>` from `origin/main` in a new worktree.
- Stage exactly the one batch file by name (`git add <path>`), commit with a message that names the kind, the count and the plan's run id, and end it with the repository's Co-Authored-By trailer line.
- Push the branch and open a PR to main whose body lists the kind, the item count, the residue (items left out and why, with the second reader's reasons when the batch carries them) and the apply step that runs on merge. End the body with the Claude Code generated-with line.
- Watch `gh pr checks` (poll every 60 seconds, at most 25 minutes). On any hook or CI failure: stop that kind, record the exact error in the run report, do not design a fix and do not retry by pushing again. Continue with the next kind.

Merging is NOT yours. The coordinator merges each PR after CI. On merge, the briefs stage applies the committed batch inside the next turn (ADR-050); while the scrape cadence is off an apply is held dry, which is expected, not a defect.

LEDGER KIND, STALE MODE. `node scripts/digest/plan-drain.mjs --kind ledger-verdicts --mode stale` (add `--dry` to print the plan, take no lease and write no plan file) plans the ledger kind alone: candidates whose committed verdicts are all under an older prompt_version, oldest first, each carrying `verdict_prompt_version`, `verdict_batch` and `verdict_classified_at` but never the old classification. Write each verdict FRESH from the exported text under the live prompt_version; never copy, adapt or carry over the old entry. The batch is a NEW file at the planned path; the old batch file is never edited. It is a run of its own, never mixed into the default run.

STEP 4, always last, even after a failure or a skipped kind:

`node scripts/digest/plan-drain.mjs --finish <plan file> --prs <kind>=<pr url>,<kind>=<pr url>`

It releases every lease the plan holds and records the run in the harness ledger (switch state, kinds, counts, leases held and released, PRs opened). A lease left unreleased goes stale after three hours and is claimable, so a lost finish never wedges an item, but it is recorded as a defect.

Final report, under 15 lines: the plan run id, per kind the exported count, the planned count, the PR url and its CI state, residue counts with reasons, lease counts held and released, and anything that failed with its exact error. Facts only.
