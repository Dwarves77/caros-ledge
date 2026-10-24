# Caro's Ledge clean-room build plan (2026-10-12)

Assembled by the coordinator from the 26 Part 1 registers under docs/plans/rebuild/part1/ (25 merged; schema.md in
flight from lane P1-11), dotfiles/docs/plans/rebuild/data-invariants.md (292 invariants), protected-properties.md (179
properties), the production schema dump (schema-2026-10-12.sql) and the operator's rulings of 2026-10-11/12. This is
the document the operator approves before any file exists in the new tree. Module-level figures come from the
registers' section 2; file-level rows live in each register's section 8 and are not repeated here.

## 1. Decisions already made (operator, binding)

1. A NEW repository, fresh `git init`, never a clone or copy; hierarchy src/core, src/features/<name>, src/ui; strict
   lint and types; a package budget (every dependency justified); no speculative code; design handoffs and docs
   outside runtime code.
2. EVERY feature is kept. Each is written as the best version of itself from the whole read recorded in its register;
   every ported file carries `// Ported from old_repo/<path> (lines a-b)`.
3. Targets: substrate 15,000 to 25,000 code lines; full platform 35,000 to 60,000. CI fails when src/core exceeds
   25,000 or src/ exceeds 60,000.
4. Everything is FREE: no metered model API, no Browserless. Every old call site is replaced (section 6).
5. The database and its rows are untouched. The schema enters the new tree as one file from the production dump.
   Data repairs become invariants with resolvers.
6. The harness is a substrate feature: one recorder, one ledger table, one chain hand-off, no committed run files.
7. The discipline layer is smaller than the product: ONE workflow (lint, types, domain tests, migration proof,
   property checks, LOC gates).
8. Port order: substrate first, then Regulations, Market, Research, Operations, Dashboard/Search/Assistant, Admin,
   Community LAST (operator 2026-10-12). Community is kept whole; it is sequenced last.
9. Done = six proofs the operator opens (section 8). Anonymity from commit one; private before go-live; the old tree
   is deleted whole after cutover.

## 2. What Part 1 found (the numbers)

| Group | Lanes | Code lines today | Lanes' clean estimate | THIS PLAN's budget |
|---|---|---|---|---|
| Substrate | 01-16 | 83,900 | 47,500 | 24,400 |
| UI kit and shell | 17, 18 | 13,800 | 7,800 | 5,500 |
| Regulations, Market, Research, Operations | 19, 20, 21 | 19,600 | 13,000 | 10,200 |
| Dashboard, search, Assistant | 24 | 6,200 | 3,850 | 2,800 |
| Admin | 25, 26 | 17,100 | 8,800 | 4,000 |
| Community | 22, 23 | 15,600 | 8,100 | 5,000 |
| Schema | 11 | 23,291 SQL lines (one file, not counted) | | |
| Total | | 155,300 | ~89,000 | ~51,900 |

Every lane's verdict is REFACTOR AND PORT; none is KEEP AS-IS; none is TRASH whole. About a third of the raw lines
are comment history narrating superseded rulings, and that is most of the lanes' cut. The lanes cleaned their own
modules; the plan's budget (last column) is the whole-system cut in section 3, which is what reaches the targets.
Budgets are per-directory ceilings the port lanes build to; the CI gates (25k core, 60k src) are the hard stops.

## 3. The whole-system cut (how 89k becomes 52k)

Each item names the duplicates the registers found across modules and the ONE home that replaces them.

1. One request guard. Three guard families (auth.ts, community-auth.ts, route-guard.ts: 331 lines for one question),
   17 copies of UUID_RE, 12 JSON-parse blocks, 9 caller-role pre-reads in Community, the same guard repeated in five
   members handlers. New: src/core/http/guard.ts (requireUser, requireAdmin, requireOrgRole) and
   src/core/http/parse.ts. Saves ~2,000.
2. Two Supabase clients, not five. User client (cookie or bearer, RLS applies) and service client (fail closed on a
   missing key); the six duplicate fallback wrappers and the memory-only stores go. src/core/db/. Saves ~1,500.
3. One query kit under each surface, not a 5,048-line reader file. supabase-server.ts and data.ts (16 cache wrappers,
   8 repeated timeout blocks, seven payload fields no consumer reads) become one src/core/db/query.ts (bounded read,
   timeout, failure never cached, never rendered empty) plus per-surface readers of 100-300 lines each. Saves ~3,000.
4. One list surface, one row. Four ledgers mount the shell and five more copy its frame; 23 per-instance style tags put
   13.5 KB of CSS on every row. New: src/ui/list/ (ListShell, ListRow, keyset paging, live facet counts) consumed by
   Regulations, Market, Research, Operations, watchlist, search, map, dashboard. Saves ~2,500.
5. One UI kit. Chips, section headers, status flashes, save controls, modals (five implementations, none with a focus
   trap), toasts and empty states exist in five or six copies across workspace, admin and community. New: src/ui/
   primitives with one Dialog, one Toast, one EmptyState, one FormField. Saves ~2,500.
6. One turn runtime and one recorder. Thirteen copies of a three-gate CLI skeleton, 37 harness families with their
   own emitters, seven turn runtimes of which six have no invoker, four jiti loaders in one applier. New:
   src/core/turn/run-turn.ts (stages sweep, change, capture, intake, connect, propagate, briefs) and
   src/core/harness/record.ts (recordRun, chain hand-off, one harness_runs table). Saves ~5,000.
7. One tier vocabulary. Six versions of the tier contract, a third host-authority table, five copies of hostOf, two
   URL canonicalisers, two scrape holds (one fails open). New: one tier module (planned as sources/tiers.ts, not built under that name) reading the institution
   class table, one hostOf, one canonicaliser, one hold that fails closed. Saves ~1,500.
8. One source decision. Three copies of approve/reject/defer in admin routes (710 lines), two recommend-classification
   routes sharing 206 lines, a second tier write path (base_tier) beside tier_override. New: one decideSourceCandidate,
   tier_override only. Saves ~1,000.
9. Admin observes and overrides. No panel approves intake (no human gates); the metered scan, regenerate, bulk-import
   verification and spend tile are not ported; the four fixture galleries and thirteen parts pages go. Admin is the
   registry, quarantine and flags, coverage requests, invitations, ledger, health: ~4,000 lines. Saves ~4,500 against
   the lanes' estimate.
10. Comment history goes everywhere; in-body comments explain the code that is there. No header essays.
11. Intake keeps one generation path: generateBriefFromInjected plus groundBrief({ injectedLedger }); grounding,
    validation and credibility growth in full; the metered half is not ported.
12. Community (last): CommunityRooms (1,597 lines, five features in one file) becomes five components on the kit; the
    moderation pair gets real columns instead of packing body, action and notes into `reason`; the four wiring defects
    are fixed in the port, not carried.

## 4. The new tree

```
new-repo/
  schema/schema.sql            the production dump, minus dead objects, plus the lanes' additions (section 5)
  src/core/                    SUBSTRATE, <= 25,000 lines (CI gate)
    http/      guard, parse, errors, rate-limit                          (P1-01)
    db/        clients, query kit, pagination, cache rules               (P1-01, P1-24)
    auth/      session, orgs, memberships, invitations                   (P1-01)
    workspace/ workspace, sector profile, settings, onboarding, profile  (P1-02)
    sources/   registry, tiers (class table), credibility, coverage model, health   (P1-05, P1-06)
    capture/   fetch policy (headless, free), capture store, change detection       (P1-07)
    intake/    staged transit, classification (deterministic), contracts, quarantine (P1-04)
    brief/     injected-brief seam, grounding, validation, claims, slots, metadata   (P1-03)
    mint/      identity, screen, all-or-nothing write, census disposition           (P1-14)
    connect/   connection discovery, tags, themes, domains                          (P1-09)
    propagate/ entities, derived values, propagation events, corrections            (P1-10)
    obligations/ obligations, forward events, timeline                              (P1-16)
    producers/ per-surface producers, learning loop, drains, research walker, spec09 (P1-15)
    turn/      the one turn runtime and its stages                                  (P1-12, P1-13)
    harness/   recordRun, chain hand-off, proofs readers                            (P1-08)
  src/features/                SURFACES
    regulations/ detail/ map/  (P1-19)   market/ figures/ (P1-20)   research/ operations/ (P1-21)
    dashboard/ watchlist/ portfolio/ search/ assistant/ (P1-24)   admin/ (P1-25, P1-26)
    community/ (P1-22, P1-23, last)
  src/ui/                      kit: primitives, list, shell, theme tokens (P1-17, P1-18)
  src/app/                     Next.js routes only (thin: each route calls one feature function)
  tests/                       domain tests only (no snapshots)
  .github/workflows/ci.yml     the ONE workflow (section 7)
  docs/  design/               specs, decisions (<= 15-rule constitution), handoffs; nothing in runtime code
```

## 5. Data: schema and invariants

- The database is not migrated. The new tree points at the same Supabase project; schema/schema.sql is the dump
  (122 tables all with RLS, 214 policies, 134 functions, 69 triggers, 6 views, 320 indexes) minus the dead objects
  P1-11 confirms, plus the additions the lanes handed over: the Community RPCs (create_group_for_self,
  accept_group_invitation, create_thread, decide_signoff, moderate_report, community_directory_counts,
  community_notification_counts), community_group_bans, three moderation_reports columns, the harness_runs ledger
  shape (P1-08), the item_corrections outbox trigger and the widened derivation_edges allowlist (P1-10), the
  monitoring_queue.last_result CHECK fixed to the values written (P1-07), migration 386's anon-grant policy (SEC-9),
  one tier vocabulary (section 9, ruling 1). Unapplied migrations 299 and 334 are folded or dropped per P1-11.
- 292 data invariants and 179 properties are the acceptance list: each is either enforced by the schema (constraint,
  policy, trigger), by code at the write site, or by a property check in CI; none is a comment.
- Verbatim provenance stands: every FACT's span is verbatim in a capture (ADR-016); a figure with a source is
  published with that source's rating, never refused (rule 18); staged_updates is transit-only; quarantine is
  research-or-erase with dated deferrals.

## 6. Free replacements (every metered or paid site, by class)

| Old | Replacement |
|---|---|
| Brief generation (callSonnet, generateBriefText) | the injected-brief seam: a brief authored outside the system is grounded, validated and grown by the same code |
| Search and corroboration (callSonnetSearch, discoverCorroborators, web search) | deterministic identifier resolvers plus the author's cited sources |
| Span judging (judgeSlotSpan) | the author confirms a verbatim floor-pool nomination |
| Classification (first-fetch classify, haiku-classify, admin recommend-classification) | the deterministic classifier; tier from the institution class table |
| Tier recommendation, bias tags, spot check, verification (admin, sources) | class table, registry vocabulary, not ported |
| Assistant (/api/ask) | retrieval over platform content and skill passages, no model call |
| Research theme backfill (Haiku) | rule-based theme classifier plus a judgement-drain kind |
| Browserless (canonical-fetch, change detection, bulk import) | one fetch policy: plain HTTP first, headless Chromium on the Actions runner for rendered pages |
| EIA API key | kept: a free key for a free public dataset (the one documented exception) |

## 7. The discipline layer (one workflow)

ci.yml, job `ci`: checkout, npm ci, lint (no unused vars or imports), typecheck (strict, null checks), build, domain
tests, migration proof (apply schema/schema.sql to an empty Postgres service container; fail on error), property
checks (RLS enabled on every table; no anon write policy; every FK indexed; no identifier or home path in the tree; no
metered SDK in package.json; no committed run artifacts), LOC gates (src/core <= 25,000; src <= 60,000, code lines).
A red run is fixed at the root cause before any re-trigger. Nothing else: no fitness engine, no governance tree.

## 8. Done: the six proofs (the operator opens each)

- P1 Sign in, land on a workspace, the Dashboard shows live items with their surfaces linked.
- P2 A source is captured, minted, grounded and verified; the item renders on Regulations with every fact-document
  section it has and its source's rating.
- P3 A Market figure renders with its source rating, band and trajectory from the figures model.
- P4 Research and Operations panels render from derived values the flywheel produced, with provenance.
- P5 One turn runs end to end by dispatch (sweep, change, capture, intake, connect, propagate) and harness_runs holds
  the run with inputs, outputs, outcome and its chained downstream.
- P6 The new repo's one workflow is green with the LOC gates and property checks, the schema proof applied, and
  production serves the new tree (Vercel repointed, secrets moved, old tree frozen).
Community's proof (groups, threads, moderation, notifications end to end) follows P6 as P7, last.

## 9. Rulings owed to the operator (decision-ready; recommendation first)

1. Tier vocabulary: six versions; OECD, IEA, World Bank, IPCC are T2 in code, T3 in the skill. Recommend: the skill's
   class table is canonical (T3); one table in the schema; code reads it.
2. Turn stage code: in src/core/turn/stages or in each owning module. Recommend: owning module exports a stage
   function; run-turn orchestrates. Keeps modules whole.
3. Public routes without auth today (obligations reads, /api/detail/relevance, /api/listings/rest): recommend
   requireUser on all except health; health stays public, rate-limited.
4. Canonical and provisional source queues as operator overrides: recommend observe-only panels; resolution by the
   SC-13 rules and the class table (no human gate).
5. Community: ban scope (recommend group-scoped with a bans table), LinkedIn as a second verification method
   (recommend keep, ported in the Community slice), My topics (recommend drop: no write path), directory k-floor
   (recommend k = 5).
6. Sector-weighted urgency composite (no caller today): recommend port, it is the Dashboard's ranking.
7. Saved views and data summary (dead): recommend drop. Customer workspace tags: recommend keep in workspace.
8. FuelEU 2030-2050 targets transcribed but not implemented: recommend implement in obligations (a feature we hold).
9. The derived-value allowlist and corrections outbox: recommend widen and add (otherwise a corrected fact never
   propagates).
10. Design changes owed to Claude Design (rule 20): five unrendered fact-document sections, the 40 px matrix cells,
    artboard 04's sparkline and YoY, the headline-row scroller.

## 10. Part 2 sequence (after approval)

1. New repo, CI first (section 7) green on an empty tree; schema/schema.sql applied in CI; anonymity checks on.
2. Substrate slices in order: core/http + db + auth (P1); workspace; sources + capture; intake + brief + mint (P2's
   pipeline); connect + propagate + obligations; producers + turn + harness (P5). Each slice: port from the register's
   section 8, domain tests, LOC check, proof step.
3. UI kit and shell; Regulations + detail + map (P2 renders); Market (P3); Research + Operations (P4);
   Dashboard/search/Assistant (P1 complete); Admin.
4. Cutover: Vercel repointed, secrets moved, old tree frozen (P6). Then Community (P7). Then the old tree is deleted
   whole and its history purged.
Amendment 2026-10-16 (operator): the src gate is 75,000; src/core stays 25,000.
