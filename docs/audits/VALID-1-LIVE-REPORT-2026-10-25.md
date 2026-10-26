# VALID-1 live report: the 32 brief rules over the 535 live old-tree briefs (2026-10-25)

Run once by the VALID-1 lane with `node scripts/ci/validator-report.mjs --live`: a read-only transaction (`set default_transaction_read_only = on`) over the production database, population `item_grade = 'brief'` and not archived (535 rows: 431 verified, 104 quarantined). Taken BEFORE SEV-1's migration 0137 applied (production still held 60 out-of-vocabulary and 80 null severity rows, which is what R17 and R18 count). Nothing was written. The register is `docs/audits/` Step A, VALIDATOR-RULES-STEP-A-2026-10-25 (in the vault), section 6.

Columns: `applied` is the briefs whose format the rule's registry row names; `rule` is the rule as registered (prose view, claims and quotations exempt as the rule defines); `repro` is the rule's predicate in the form the register counted it (whole body, or the register's own variant where the rule is deliberately different); `register` is the register's count; `diff` is repro minus register. A multi-number cell is one number per register predicate.

```
rule                               applied  rule      repro   register diff
dash-outside-verbatim                  535   285        290        290 0
workspace-or-client-named              535     0          0          0 0
generic-action-phrase                  535     6          6          6 0
tier-phrase-exposure                   535   135        135        135 0
score-or-schema-token                  535     1          1          1 0
stored-date-stated                     535    58      22/39      22/39 0/0
what-it-changes-length                 535   396        396        396 0
fact-span-in-own-section               535   402        371        371 0
do-now-severity-label                  469   358        358        358 0
sources-used-non-empty                 535   283        283        283 0
as-of-has-date                         535   271        273        273 0
required-sections-present              535   265        265        265 0
accounting-line-present                390   323        260        260 0
no-claim-ledger-json                   535     4          4          4 0
pipeline-narration                     535   199        199        199 0
fact-span-in-capture                   535     0          0          0 0
severity-in-vocabulary                 535    60         60         60 0
severity-present                       498    80         80         80 0
priority-follows-map                   535    28         28         28 0
banner-matches-column                  535    12          9          9 0
pool-or-slot-narration                 535   153   100/45/9   100/45/9 0/0/0
no-bare-url-in-prose                   535    75         75         75 0
no-html-entity-outside-spans           535     5         11         11 0
no-ibid                                535     9          9          9 0
h1-in-section-list                     535    70         70         70 0
urgency-tier-in-vocabulary             535   139        139        139 0
summary-fields-non-blank               535   225      225/8      225/8 0/0
topic-tags-vocabulary-and-cap          535    59      59/47      59/47 0/0
band-or-theme-present                  112    65         65         65 0
no-double-hyphen-dash                  535   141        141        141 0
no-section-sign                        535    14         14         14 0
structural-controls                    535     0        0/0        0/0 0/0
validator-report --live: 32 rules, 0 count(s) differ from the register
```

Reproduction: every register count is reproduced exactly (0 differences in 32 rules). The three severity counts SEV-1 repairs are R17 60 (53 reference, 5 background, 2 high), R18 80 and R19 28.

## Where the rule differs from the register's predicate, and why

- [CONFIRMED: probe over the pre-SEV-1 snapshot] dash-outside-verbatim 285 against 290: the register exempted any ASCII or curly quoted run; the rule exempts the source_span of FACT claims (not their text) and the quoted run of a FACT line. 10 briefs the register flags are exempt in the rule (a dash inside a FACT claim's span that carries no quote marks); 5 briefs the rule flags carry a dash inside a quotation on a line that is not a FACT line.
- [CONFIRMED: same probe] no-html-entity-outside-spans 5 against 11: the other 6 hits sit inside FACT quotations, source wording the rule does not edit. as-of-has-date 271 against 273: 2 briefs whose "as of" sits in, or is followed by, a verbatim run.
- [CONFIRMED: count] fact-span-in-own-section 402 against 371: the rule keeps mirror f's second half (a claim's declared section is a key of the format); 31 briefs hold claims in sections such as `record_facts` or a key the format does not have. The span half alone reproduces 371.
- [CONFIRMED: probe] banner-matches-column 12 against 9: the rule compares the SET of banner labels, so a two-label banner whose first label is the column's own now fails (68af8b45, c26f4ac6, cd1083c9).
- accounting-line-present 323 against 260: the rule is mirrors d and e whole (depth accounting, qualification accounting, the tail after the line), not only the line's presence; the stored rows carry no pool size and no trajectory column in the adapter, so the extra 63 are the qualification checks. [HYPOTHESIS: the 63 split by check was not taken.]
- stored-date-stated 58 briefs against 22 and 39 by column: the 22 and 39 are the register's three renderings; the rule accepts the day-level renderings in `src/core/brief/data/date-renderings.json` and counts a brief once.
- h1-in-section-list 70, equal: the extractor also folds -ize and -ise, which would give 49; 21 briefs write "Materialises" for the contract's "Materializes". The rule compares the contract's heading exactly (case-insensitive), as the register did.
