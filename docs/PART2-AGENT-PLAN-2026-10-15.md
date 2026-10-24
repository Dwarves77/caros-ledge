# Part 2 agent plan (2026-10-15): building the approved plan with Sonnet and Haiku at Fable's instruction

Governs the execution of docs/BUILD-PLAN-2026-10-12.md (approved by the operator 2026-10-15). Fable
(the coordinator) writes every brief, reads every slice's diff before merge, merges, and rules; Sonnet lanes build;
Haiku lanes do mechanical work only. Inputs per slice: the module's Part 1 register (section 8 file list, section 7
file verdicts, the invariants it enforces), ASSEMBLY-INPUTS-2026-10-12.md (interfaces D, duplicates E, defects H),
the schema register, data-invariants.md, protected-properties.md, the old code itself (read whole before porting).

## 1. Roles and rules

- Fable: briefs with the exact file list, interface (exports and imports by slice id), invariants to test (INV ids),
  defects not to repeat (H ids), LOC budget, proof step; reads each PR diff; merges; keeps this plan current.
- Sonnet build lane (one per slice): reads its register whole and every old file it ports whole; writes the slice
  under src/ with `// Ported from old_repo/<path> (lines a-b)` on every file; domain tests for every invariant in
  its brief (no snapshots); runs lint, typecheck, tests, LOC count locally; one PR, one CI run, a 10-line report;
  never a new dependency without a line in package.json's "budget" block saying why; never a metered SDK.
- Haiku lane (mechanical only): port-header audit (every file's header names an existing old path and line range;
  LOC per directory), parity captures, schema file assembly by a named list, index and backlog lines, file moves by
  a given map. Never a design decision, never a verdict.
- Where lanes run: the operator is on Remote Control (phone), so lanes run in the operator's cloud sessions
  (opened with Sonnet or Haiku selected); each cloud session spawns one fresh session per lane and forwards the
  brief verbatim. When the operator is at the desktop, lanes run locally with the model named in the brief.
- Repository: github.com/Dwarves77/caros-ledge, public while building (unlimited Actions minutes; anonymity from
  commit one: author "Claude", no personal name, email or home path anywhere), private before go-live. Branch
  protection: required check `ci`, strict off. Default branch main.
- Every PR: one `ci` run; a red run is fixed at the root cause before any re-trigger; nothing pushed after green;
  WIP commits carry `[skip ci]`; squash-merged by the coordinator with a subject naming the slice and its LOC.

## 2. The one workflow (built first, in P2-00)

ci.yml, job `ci`, on pull_request and push to main: checkout; node 24; npm ci; lint (eslint strict: no unused vars or
imports, no explicit any, import order); typecheck (strict, noUncheckedIndexedAccess); build (placeholder Supabase
env); domain tests (node --test or vitest, tests/ only); schema proof (postgres:15 service container; `psql -f
schema/schema.sql` must succeed on an empty database); property checks (scripts/ci/properties.mjs: RLS enabled on
every table in schema.sql; no policy grants anon INSERT/UPDATE/DELETE; every FK has an index; no file in src/
without a Ported-from header except files listed in scripts/ci/new-files.txt with a reason; no personal identifier
or home path in the tree; no metered SDK in package.json; no file under src/ over 400 lines without an allow line);
LOC gates (scripts/ci/loc.mjs: code lines, src/core <= 25,000, src <= 60,000; prints the per-directory table into the
job summary). A second job `parity` (section 7) runs on deployment_status success of the Vercel preview and on
workflow_dispatch; it is not required for merge until the UI wave.

## 3. Waves and slices (dependency order; parallel inside a wave)

Wave 0 (now)
- P2-00 bootstrap (Sonnet): the repo skeleton: package.json (next, react, @supabase/supabase-js, zod only; "budget"
  block), tsconfig strict, eslint, next.config, src/app/layout.tsx + one page, tests/ scaffold, scripts/ci/{loc,
  properties,new-files}.mjs, ci.yml as section 2, schema/schema.sql (H-1's output), README (what the tree is, the
  rules, the proofs), docs/ with BUILD-PLAN and this plan copied in. Proof: `ci` green on the empty tree including
  the schema proof against a fresh Postgres. LOC budget 600.
- H-1 schema file (Haiku): dotfiles/docs/plans/rebuild/schema-2026-10-12.sql minus the dead objects named in
  dotfiles/docs/plans/rebuild/part1/schema.md section 8 (by exact object name), plus the additions schema.md lists as SQL
  verbatim; counts before and after; the diff as the PR body. Lands as schema/schema.sql in P2-00's branch.
- H-2 parity baseline (Haiku, in the OLD repo): .github/workflows/parity-baseline.yml, workflow_dispatch, Playwright
  v1.61.1 image, signs in with LIVE_SMOKE_EMAIL/PASSWORD, captures every route in tests/parity/routes.json at 1280
  and 375 px: a full-page PNG and the accessibility tree (roles, names, headings, landmarks, text of each row) as
  JSON; uploads one artifact `parity-baseline-<sha>`. Fable fires it once; the artifact is downloaded and committed to
  the new repo under tests/parity/baseline/ by H-2's second half.

Wave 1 (after P2-00 merges)
- P2-01 core foundation (Sonnet): src/core/http (guard: requireUser, requireAdmin, requireOrgRole; parse; errors;
  rate-limit), src/core/db (user client, service client fail-closed, query kit: bounded read, timeout, never cache a
  failure, keyset paging), src/core/auth (session, orgs, memberships, invitations, the email seam), src/core/shared
  (telemetry captureError/withErrorCapture, dates, text/html-to-text, domains, url canonicaliser + hostOf, ids),
  src/core/types. Sources: auth-db.md s8, the unassigned needs in ASSEMBLY D.5 (telemetry, email, domains, text,
  format, url). Invariants: INV-153..155 and the guard/read properties. Budget 3,000. Proof: P1 part a (sign in,
  org resolved) as a domain test against a fake client plus one live smoke on the preview.

Wave 2 (parallel, each imports only P2-01)
- P2-02 workspace (Sonnet): workspace, sector profile, settings (key-wise jsonb patch, INV-168), onboarding, profile,
  account; customer workspace tags (ruling 7). Budget 2,500.
- P2-03 sources + capture (Sonnet): registry, tiers from the class table (ruling 1: skill is canonical), credibility,
  coverage model, health, fetch policy (plain HTTP, headless on the runner), capture store (full body, declared
  transforms, INV-165..167 as renumbered), change detection, the hold that fails closed. Budget 4,600.
- P2-04 intake + brief (Sonnet): staged transit (RD-20), deterministic classification, contracts, quarantine with
  dated deferrals, the injected-brief seam, grounding, validation (verbatim spans, slots, metadata vocab with
  candidate banking), credibility growth. Budget 4,000.
- P2-05 mint (Sonnet): identity, screen verdict on the payload, all-or-nothing write, whole capture, census
  disposition, numeric fold. Budget 2,000.
- P2-06 connect + propagate + obligations (Sonnet): connection discovery, tags, themes, entities, derived values,
  propagation events with the widened allowlist and the corrections outbox (ruling 9), obligations, forward events,
  the four-date timeline, FuelEU targets (ruling 8). Budget 4,500.
- P2-07 producers + learning (Sonnet): the one producer runner (replacing 13 CLI skeletons), the per-surface
  producers, learning loop, drains, research walker, spec09 calc. Budget 4,500.

Wave 3 (after wave 2)
- P2-08 turn + harness (Sonnet): run-turn.ts with stages (sweep, change, capture, intake, connect, propagate,
  briefs) calling each module's stage export (ruling 2); recordRun, chain hand-off, harness_runs; the dispatcher
  that reads the hold and kill switch; proofs readers. Budget 2,300 (harness 500). Proof: P5 by dispatch on the
  preview against production data in record-only mode.
- P2-09 ui kit + shell + list (Sonnet): tokens (theme.css as the one source), primitives (Dialog with focus trap,
  Toast, EmptyState, FormField, chips, bands), ListShell + ListRow + paging + facets, AppShell, nav, banner, error
  and loading states, rating and bias display. Parity: the shell routes match the baseline (section 7). Budget 5,500.

Wave 4 (parallel surfaces; each imports core + ui)
- P2-10 Regulations + detail + map (Sonnet): every fact-document section rendered (the five unrendered ones per
  design change 10), statutory and jurisdiction models, applicability, map as a filter view. Budget 4,200. Proof P2.
- P2-11 Market + figures (Sonnet): figures model with source rating on every figure (INV-262 gap closed), bands,
  trajectories, vocabulary. Budget 2,600. Proof P3.
- P2-12 Research + Operations (Sonnet): horizon assessments; jurisdictional panels from derived values; the four
  logic defects fixed (H). Budget 3,400. Proof P4.
- P2-13 Dashboard + watchlist + portfolio + search + Assistant (Sonnet): digest with sector-weighted urgency (ruling
  6), watch vocabulary, portfolios as selections, Standard Search on the caller's client, the free Assistant
  (retrieval over content and skill passages). Budget 2,800. Proof P1 complete.
- P2-14 Admin (Sonnet): observe-and-override only; registry, quarantine and flags, coverage requests, invitations,
  ledger, health; one decideSourceCandidate; tier_override only. Budget 4,000.

Wave 5
- P2-15 cutover (Sonnet + Fable): Vercel project for the new repo, env moved (never printed), preview to production,
  domain repointed, old project frozen; the six proofs opened by the operator (P6). Parity required on every route.
- P2-16 Community (Sonnet, last): groups, threads, posts, moderation with real columns and a bans table (ruling 5),
  notifications honouring preferences and mutes, directory with k = 5, the four wiring defects fixed. Budget 5,000.
  Proof P7.
- P2-17 retirement (Haiku + Fable): the old repo made private, history purged (identifiers, deleted paths), then
  deleted whole; Part 1 registers and the build plan copied into the new repo's docs/ first.

## 4. Per-slice brief template (Fable writes one per slice)

SLICE id and name; BRANCH slice/<id>; BUDGET (code lines); READ WHOLE: the register(s), the old files listed in the
register's section 7 as KEEP or REFACTOR (paths and line counts), the relevant rows of ASSEMBLY D (needs and offers),
E (duplicates: the one home), H (defects to not repeat); INTERFACE: exports this slice provides (names, signatures)
and imports it takes (from which merged slice); FILES: the register's section 8 rows (new path, from old path and
lines, responsibility, LOC) with Fable's amendments; INVARIANTS: INV ids with the test each gets; PROPERTIES: PROP
ids the slice carries; PROOF: the step and how it is shown; RULES: headers, budget block, no metered call, parity
for UI slices; LANDING: tests green locally, LOC table, one PR, one CI run, 10-line report (files and LOC; invariants
tested; defects fixed; interface delivered; anything not ported and why; CI run id).

## 5. Fable's review before merge (every slice)

Read the PR diff; check: every file has its header and the header's source exists in the old tree at those lines;
no file outside the slice's directories; exports match the brief's interface; every INV in the brief has a test;
no new dependency without its budget line; LOC within budget; no metered SDK; no identifier. A miss is sent back
with the exact file and line; the fix is one commit and the PR's second (last) CI run.

## 6. Haiku lanes (mechanical, standing)

H-1 schema file (wave 0). H-2 parity baseline (wave 0). H-3 port-header audit after each wave (every src file's
header resolves; LOC table; the list of src files with no header). H-4 old-repo bookkeeping (INDEX lines, backlog
STATUS cells for rows a slice closes, session-log index). H-5 file moves by a given map when Fable reassigns a
file between slices. H-6 retirement mechanics (wave 5).

## 7. Playwright parity (operator 2026-10-15: "use playwright to make sure what we build matches what exists")

- Baseline: the existing site, captured once now (H-2) while the old tree serves: for every route in
  tests/parity/routes.json (signed-out: /, /login, /signup, /privacy; signed-in: /dashboard, /regulations, one
  regulation detail, /market, one market detail, /research, /operations, /map, /search?q=..., /watchlist,
  /community and one group, /settings, /profile, /admin and its panels), at 1280 and 375 px: full-page PNG and the
  accessibility tree JSON (landmarks, headings in order, roles and names of interactive elements, the first 20 list
  rows' text, the measured row heights at 375 px).
- Gate: tests/parity/compare.mjs runs in the `parity` job against the PR's Vercel preview with the same routes; it
  fails a UI slice when any baseline landmark, heading, control or list field on that slice's routes is missing or
  reordered, or when any row exceeds its baseline height at 375 px; pixel diff is reported (threshold 2 percent of
  pixels) but gates only on routes listed as pixel-exact. Approved design changes (BUILD-PLAN ruling 10, the artboard
  divergences) are listed in tests/parity/approved-changes.json with the ruling that approved each; only those may
  differ.
- Signed-in routes need LIVE_SMOKE_EMAIL and LIVE_SMOKE_PASSWORD in the new repo's secrets: the one step on the
  operator's side (the values are not readable from the old repo's secrets); until set, parity gates the signed-out
  routes and reports the rest.

- What parity is for (operator 2026-10-15: "we want to build everything BETTER than what exists, I just don't want
  the designs to veer off base"): the gate holds the DESIGN (layout, spacing, type, colour tokens, structure and
  order of what a page shows) to the artboards and the existing site; it never freezes behaviour, data, speed or
  correctness. A slice that renders the same design with better data, fewer requests, correct values or a fixed
  defect passes; a slice that changes what a page looks like without a ruling fails.

## 8. Improvements found during the build (operator 2026-10-15: "if during the build you find something that can be
done better in ANY way let's discuss it")

Every lane report carries an IMPROVEMENTS block: anything the lane saw that could be done better (a mechanism, a
model, a query, a flow, a design element, a rule), each as `what | why better | cost | what it touches`. Fable
collects them after each wave into dotfiles/docs/plans/rebuild/IMPROVEMENTS.md with a recommendation per item and brings the
list to the operator for discussion; none is applied without the operator's word and none is dropped silently.
Improvements inside a slice's own budget that change no design and no interface (a cleaner algorithm, a missing
index, a bounded read) are built in and reported, not held.

## 9. Reporting

After each wave: merged slices with LOC against budget, the running src/core and src totals, proofs passed, parity
state, rulings taken, anything not ported with the reason. The operator opens each proof when its wave lands.
