# Cutover runbook, October 2026 (P2-15)

Production serves the new tree. This is the checklist of the window the operator opens: every step names its owner (**operator** or **lane**), the exact command or dashboard path, the proof that it worked (what to look at, what to expect), and its rollback. Nothing here is applied to production before the window; the old tree stays frozen and serving until the new tree serves (ruling 16 of 2026-10-11) and is paused, not deleted, until P6 is opened. A secret is never printed, never committed, never pasted into a report: this file names environment variables, never a value.

Dashboard paths and button labels below are as of October 2026 and are the one part of this file not checked by a command: if a label differs on the screen, the step's PURPOSE and PROOF still stand.

## Before the window opens (gate)

- P2-S4 and P2-16 are merged; the parity job on main is green; every route in `tests/parity/routes.json` passes (`npm run parity` locally, the `parity` job in CI).
- There are no `until-migration` parity waivers: the kind is gone, and what production carries is `public.migration_log` (migration 0078), written by the `migrate` job.
- The Supabase CLI is installed and linked: `supabase login`, then `supabase link --project-ref <the production project ref>` (the ref is in the project's dashboard URL). Check: `supabase db query --linked "select 1"` prints one row.
- The lane works in a clean clone of the repo at the merge commit, with `npm ci`, and a `cutover-run/` directory (gitignored) that holds every command's full output as the run artifact.

## Environment names

Names only; the values are entered in the places named and are never written down here. "Vercel" is the new project's Environment Variables (Production and Preview unless noted). "GitHub" is the repository's Actions secrets. "Edge" is the Supabase Edge Function secrets. `scripts/ci/env-names.mjs` lists what the tree reads and `tests/cutover/env-names.test.ts` fails when this table and the code disagree.

| name | set in | read by | note |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel, GitHub | `src/core/db/clients.ts`, `src/core/db/browser.ts`, the live checks, the turn | the production project URL; copy from the old project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel, GitHub | `src/core/db/clients.ts`, `src/core/db/browser.ts`, the live checks | rotated in step 5 after the new project carries it; the name stays whatever the key kind |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel, GitHub | `src/core/db/clients.ts`, the Edge Function, the live checks, the turn | server only; never a `NEXT_PUBLIC_` name |
| `WORKER_SECRET` | Vercel, GitHub | `src/core/http/guard.ts` (worker routes), `src/features/community/lib/org-key.ts` (fallback) | copy from the old project; rotating it also moves the organisation key unless `COMMUNITY_ORG_SALT` is set |
| `COMMUNITY_ORG_SALT` | Vercel | `src/features/community/lib/org-key.ts` | the SAME value as the old project (the production `community_member_profiles.organisation_key` values were derived with it); set once, never rotated |
| `NEXT_PUBLIC_APP_URL` | Vercel, GitHub | `src/features/auth/api/invitations.ts` (invitation links) | the production origin, with scheme and no trailing slash |
| `RESEND_API_KEY` | Vercel, GitHub (for the e-mail live check) | `src/core/shared/email.ts` | new; free tier (IMP-014), step 6 |
| `INVITATION_FROM_EMAIL` | Vercel, GitHub | `src/core/shared/email.ts` | an address on the domain verified in Resend; with the key above it turns the invitation e-mail on, without either it stays copy-link |
| `ASSISTANT_ENABLED` | Vercel | `src/features/workspace/api/bootstrap.ts` | leave unset (on); `false` turns the Assistant off |
| `SCRAPE_HOLD` | Vercel, GitHub | `src/core/fetch/hold.ts` | leave unset. Build mode is held by `system_state.scrape_cadence = 'off'` (rule 16); this is the second, environment switch and an unrecognised value counts as engaged |
| `OPENALEX_POLITE_EMAIL` | Vercel | `src/core/http/openalex.ts` | optional contact address for OpenAlex's polite pool; leave unset unless the operator wants one |
| `SEC_FAIR_ACCESS_UA` | GitHub (turn) | `src/core/fetch/direct.ts` | the User-Agent SEC requires for fair access; the turn only |
| `BOT_CONTACT_EMAIL` | Vercel | `src/app/bot/page.tsx` | the contact address the /bot page (the crawler's declared identity) shows to publishers; unset, the page says the address is not set yet (R2c) |
| `EIA_API_KEY` | GitHub (turn) | `src/features/market/producers/eia-petroleum-spot.ts` | free EIA key; the producer is off at cutover (`MARKET_PRODUCER_EIA_V2_ENABLED` unset) |
| `STORAGE_MAX_CHARS` | Edge, Vercel | `src/core/fetch/policy.ts`, `supabase/functions/capture-worker/index.ts` | optional; the shared default is 10,000,000 |
| `SUPABASE_URL` | Edge (supplied by Supabase) | `supabase/functions/capture-worker/index.ts` | provided to every Edge Function; not entered by hand |
| `PRODUCER_SUMMARY_DIR` | GitHub (turn) | `src/core/turn/wiring.ts` | optional; where producer summaries are written |
| `MARKET_PRODUCER_ECB_FX_ENABLED`, `MARKET_PRODUCER_EIA_V2_ENABLED`, `MARKET_PRODUCER_EU_OIL_BULLETIN_ENABLED`, `MARKET_PRODUCER_INDEXATION_ROWS_ENABLED`, `MARKET_PRODUCER_PUBLISHED_STATS_ENABLED`, `MARKET_PRODUCER_REROUTE_ROWS_ENABLED`, `MARKET_PRODUCER_SBTI_ENABLED`, `OEM_PRODUCER_ROWS_FILE_ENABLED`, `OPERATIONS_PRODUCER_AUX_ENERGY_ROWS_ENABLED`, `OPERATIONS_PRODUCER_GRID_QUEUE_ROWS_ENABLED`, `OPERATIONS_PRODUCER_UKPN_HEATMAP_ENABLED`, `REGIONAL_PRODUCER_BLS_OEWS_ENABLED`, `REGIONAL_PRODUCER_EUROSTAT_LC_LCI_LEV_ENABLED`, `REGIONAL_PRODUCER_EUROSTAT_NRG_PC_205_ENABLED`, `REGIONAL_PRODUCER_NESO_CARBON_INTENSITY_ENABLED`, `RESEARCH_ASSESSMENT_PRODUCER_ENABLED`, `RESEARCH_WALKER_ENABLED` | nowhere at cutover | `src/core/producers/runner.ts` (the kill switches) | each producer's reviewed constant is armed (ARM-1, operator ruling 2026-10-23) except carrier-ets-surcharge, sbti-target-dashboard and research-walker, which stay disabled; a switch is set to 1 only on the dispatch that runs its producer, none at cutover |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA` | supplied by Vercel | `src/core/turn/wiring.ts` (the startup refusal), `src/core/shared/telemetry.ts`, `src/features/telemetry/api/version.ts` | not entered by hand |
| `GITHUB_ACTIONS`, `GITHUB_RUN_ID`, `GITHUB_SHA` | supplied by GitHub | `src/core/harness/run.ts` | not entered by hand |
| `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_STEP_SUMMARY` | supplied by GitHub | `src/core/harness/exit.ts` (the exit-code contract: a fork pull request self-skips, any other CI event with a missing secret fails, and the verdict is written to the job summary) | not entered by hand |
| `NODE_ENV`, `NEXT_RUNTIME` | supplied by Next | `src/core/shared/telemetry.ts`, `src/instrumentation.ts` | not entered by hand |
| `UI_FIXTURES` | **never** in Vercel; set only by the CI parity job | `src/app/privacy/ui-fixtures/**` | it opens the fixture routes; check Vercel has no variable of this name |

Names the tooling reads and the tree does not (GitHub secrets for the live checks and the deployed-preview parity): `LIVE_SMOKE_EMAIL`, `LIVE_SMOKE_PASSWORD` (the member test account), `LIVE_ADMIN_EMAIL`, `LIVE_ADMIN_PASSWORD` (the platform-admin test account; the admin checks and the admin parity capture run only when both are set), `VERCEL_AUTOMATION_BYPASS_SECRET` (step 1), `LIVE_BASE_URL` (set by the workflow from the deployment), `DATABASE_URL` (the schema job and `schema:local` only; a production connection string is used by hand only when the CLI refuses a file, step 2). Optional API credentials of the collection ladder, read by name from the publisher table (src/core/sources/data/publishers-by-scheme.json) and self-skipping when unset: `REGULATIONS_GOV_API_KEY` (free, api.data.gov signup); `EURLEX_WS_USER`, `EURLEX_WS_PASSWORD` and `NYSENATE_API_KEY` are named by entries that are unverified and unused until their terms are read.

`vercel.json` is committed (framework `nextjs`, region `sfo1`, as the old project) and names no project; the project itself is created by importing the repository.

## The window

### 0. Before: the first live check (lane)

Purpose: see what production's database does for a member today (IMP-116). The new tree's first preview deployment, connected to the production project, is checked with the objects of 0038, 0040, 0042 and 0064 still absent.

1. Command: `gh workflow run ci.yml -f only=live -f live_url=<the preview URL> -f live_phase=before -f live_checks=member-reads` (or `node scripts/ci/live-checks.mjs --base <preview URL> --phase before --only member-reads` with the GitHub secret names set in the shell).
2. Proof: a `live-smoke` row in `harness_runs` with `inputs.check = member-reads`, `inputs.phase = before`; the job log shows warnings naming migrations 0038, 0040, 0042 and 0064, and (if the production view still returns a member nothing) the line `a member reads 0 current assessments where N belong to items a member may open`. A FAIL line other than a missing-object warning is a finding to report before the window.
3. Rollback: none needed (reads only; it leaves no row but the ledger row).

### 1. Vercel project and preview (operator, then lane)

1. Operator: Vercel dashboard, Add New, Project, Import Git Repository, choose `Dwarves77/caros-ledge` (the repository is private: the Vercel GitHub app must be allowed to read it). Framework Next.js is detected; leave the build and output settings.
2. Operator: Project Settings, Environment Variables: enter every name in the table above whose "set in" says Vercel, with the values from the old project (Settings, Environment Variables there), `NEXT_PUBLIC_APP_URL` as the production origin, `COMMUNITY_ORG_SALT` copied exactly. Do not set `UI_FIXTURES`.
3. Operator: Project Settings, Deployment Protection, enable Protection Bypass for Automation; Vercel then carries `VERCEL_AUTOMATION_BYPASS_SECRET`; enter the same value as a GitHub secret of that name so the live checks and the preview parity reach the protected preview. GitHub secrets for the live checks (Settings, Secrets and variables, Actions): the names in the note under the table.
4. Proof: the first deployment is green in Vercel; the successful `Vercel` commit status fires the `live` job (and `preview-parity` for a preview) by itself (the `status` event); `gh run list --workflow=ci.yml` shows them. Lane: the `live` job's rows are present (sign-in, pages, identity-anonymous, provenance-trigger, notification-drain, member-reads; admin-pages when the admin account is set) and `preview-parity` captures the admin routes with `PARITY_ADMIN=1`. Before step 2 below, `provenance-trigger` and `member-reads` are expected to warn or fail on absent objects: run them again with `-f live_phase=after` after step 2.
5. Rollback: delete the Vercel project (nothing else depends on it yet); production traffic is untouched.

### 2. Migrations in APPLY.md order (lane)

1. Command per file, exactly as `supabase/migrations/APPLY.md` lists it (generated from the directory; the schema job fails if it drifts): `supabase db query --linked -f supabase/migrations/<file>`. Run phase 1 (schema files) in order, stopping at the first failure. Rows marked HOLD wait for their step: 0066 waits for step 4, 0067 waits for the export in step 3. Keep each command's full output in `cutover-run/<NNNN>.log` and append the file name to `cutover-run/applied.txt` after it succeeds.
2. Proof per file: exit code 0 and no ERROR line (the file's last block is its self-check, which raises on failure and rolls the file back). The self-check id of each file is in its APPLY.md row. A file that fails stops the window: report it with its log; do not skip it and do not edit it to pass.
3. Nothing is written to git after the apply: each file records itself in `public.migration_log` in its own transaction (the `migrate` job); `select file from public.migration_log` is the record.
4. Operator decision at 0008: `0008_harness_runs_one_ledger` drops the old ledger columns after folding them into `inputs` and `outputs` (no row is lost). The additive-only variant (old columns kept) is offered if the operator wants zero column drops; the default is to apply it as written. `0018_invitation_tokens_hashed` drops the raw token column after storing its hash.
5. Rollback: each row's `rollback` cell in APPLY.md is the file's own `Reversal:` header. 0008, 0018 and 0067 are not reversible from SQL; their safety is the folded documents (0008), the hash (0018) and the export (0067). The old tree is frozen, not changed, so while the new tree is not yet serving, a failed window leaves production serving the old tree on a database the old tree may no longer match: apply the Reversal of every file applied, newest first, and stop.

### 3. Data files, the export and the Edge Function (lane)

1. Data files (phase 2 of APPLY.md, in order, each after the schema it names): 0011, 0015, 0030, 0045, 0046, 0061; then 0016, generated here from a read-only export of the live registry: `node scripts/cutover/export-table.mjs sources --select id,name,url,source_role,source_type --out cutover-run/sources-export.json`, then the generator command in APPLY.md phase 3, commit `0016_data_source_type_backfill.sql` with its README row, and run it. Proof: each file exits 0 with no ERROR line; a data file prints a NOTICE for anything it skipped (0015 lists census ids absent from `census_worklist`, 0030 lists absent items), and a skip is reported, never ignored. Afterwards `select count(*) from public.market_series_items` is at least the six attachments of 0030, and `select count(*) from public.host_verdicts` includes the two of 0046.
2. The dead-table export (before 0067): `node scripts/cutover/export-table.mjs coverage_gap_census_findings` writes `docs/archive/logs/<date>-coverage_gap_census_findings.json` and prints the row count and its sha256. Proof: the count equals `supabase db query --linked "select count(*) from public.coverage_gap_census_findings"` (116 at the time of the register). Only then run 0067; commit the export file.
3. Capture Edge Function (IMP-029): the bundle is proven in CI (`npm run edge-bundle`: Deno bundles the entry point with its relative import of the fetch policy; the Supabase CLI has no build command, versions 2.95.4 and 2.121.0 were read). Deploy: `supabase functions deploy capture-worker --use-api` (server-side bundling, no Docker). Proof: `supabase functions list` shows `capture-worker` with a new version number and `ACTIVE`. Rollback: redeploy the previous version from the old repository's `supabase/functions/capture-worker`.

### 4. The duplicate-email query (operator reads, lane runs)

1. Command: `supabase db query --linked -f scripts/cutover/duplicate-emails.sql -o table`. It is read-only and prints only a lower-cased address and a count.
2. Proof: no row means 0066 may run (`supabase db query --linked -f supabase/migrations/0066_profiles_email_lower_unique.sql`, then the file's APPLY.md row is done). Any row: the operator rules (merge the accounts by hand in the dashboard, or leave 0066 unapplied). Default if undecided: 0066 stays unapplied, nothing else depends on it, the plain index of 0020 keeps the lookup fast.
3. Rollback: the Reversal header of 0066 (recreate the plain index, drop the unique one).

### 5. Supabase keys (operator)

1. Asymmetric JWT signing keys (IMP-010): Supabase dashboard, Project Settings, JWT Keys (the signing keys page); create the new asymmetric key and migrate to it as the dashboard directs. Proof: after each change the lane runs `node scripts/ci/live-checks.mjs --base <preview URL> --only sign-in,pages` (or the dispatch form of step 0) and `sign-in` passes. Rollback: keep the previous key in place and do not revoke it until step 7 has passed.
2. The anon key rotation: after the NEW project's Vercel environment carries the new value of `NEXT_PUBLIC_SUPABASE_ANON_KEY` (and the GitHub secret), disable the old key in Project Settings, API Keys. Proof: `sign-in` and `member-reads` pass on the preview with the new value; the old tree (frozen) stops working with the old key by design, so do this only at the moment the new tree serves (step 7), not before. Default if undecided: no rotation; the old key keeps working for both trees.

### 6. Resend (operator, then lane)

1. Operator: create a Resend account on the free tier; Domains, Add Domain; add the records Resend lists (SPF and DKIM) at the DNS host; wait until the domain shows Verified; API Keys, Create API Key with sending access; enter it in Vercel as `RESEND_API_KEY` and set `INVITATION_FROM_EMAIL` to an address on that domain, and add both as GitHub secrets.
2. Lane proof: `gh workflow run ci.yml -f only=live -f live_url=<URL> -f live_checks=invitation-email` (the e-mail check runs only when named): the row `invitation-email` is `success` and one message arrives in the member test account's inbox. Rollback: remove the two Vercel variables; invitations return to copy-link (`configured: false`).

### 7. The domain and the old project (operator, then lane)

1. Operator: Vercel, the new project, Settings, Domains: add the production domain; at the DNS host (or in Vercel if the DNS is there) repoint the domain to the new project as Vercel instructs; Vercel, the OLD project, Settings, pause deployments (do not delete it).
2. Lane: `gh workflow run ci.yml -f only=live -f live_url=https://<production domain>` for the live checks, and the full parity capture with `PARITY_ADMIN=1` against production (`node tests/parity/capture.mjs --base https://<production domain> --out parity-capture` with the four `LIVE_*` names in the environment, then `node tests/parity/compare.mjs --captured parity-capture`).
3. Proof: every live check `PASS` in the job log and as `live-smoke` rows with `success`; parity compare exit 0. Rollback: repoint the domain to the old project and un-pause it (the old project is frozen, not deleted, until P6 is opened).

### 8. UN/LOCODE licence (operator ruling, lane names the line)

The map and the corridor labels read five place names from `src/core/entities/data/unlocode-names.json` (CNSHA, NLRTM, USNYC, USLAX, ITGOA). The licence table records UN/LOCODE as `redistribution: "prohibited"` at `src/core/contracts/data/source-licences.json`, key `un_locode` (lines 271 to 283: UN Terms and Conditions of Use, `https://unlocode.unece.org/terms`; the table's own note: treat LOCODE as an input alias, never a published dataset; the cheap next step is to ask UNECE in writing about commercial reuse). Operator: confirm the terms for the five names, or rule that the labels use the place name without the code. Proof: the ruling is recorded as an ADR in `docs/decisions` and the `un_locode` entry of `source-licences.json` is updated in a PR. Default if undecided: the five names stay as the old tree published them.

### 9. The six proofs (both, in the browser)

Open each against production and tick it here in the second PR, with the URL visited and what was seen. P1 to P6 are the six demonstrations of the build plan; P7 (Community) follows once P2-16's parity passes on production.

- [ ] P1 ______  [ ] P2 ______  [ ] P3 ______  [ ] P4 ______  [ ] P5 ______  [ ] P6 ______  [ ] P7 ______

## After the window (lane, then the coordinator)

1. `tests/parity/baseline` is recaptured once from the NEW production (the baseline is then the new site; `tests/parity/baseline/README.md` says so): `gh workflow run ci.yml -f only=baseline` is the old-site recapture; for the new site run `node tests/parity/capture.mjs --base https://<production domain> --out parity-baseline` with the member account and commit the result in a PR of its own.
2. The coordinator updates PROGRAM-BOARD and the resume file, then launches P2-17 (the old repository private, history purged of identifiers and deleted paths, then deleted whole; the Part 1 registers, the build plan, WHY, the briefs and the rulings copied into this repository's `docs/` first, with INDEX lines).
3. No cadence is set. The turn runs by dispatch only; the operator sets a scrape time in a later ruling (rule 16).
4. A ruled producer run is dispatched from the Actions form (only=turn, stage=propagate, chain=false, mode, input) with two more pieces, both for that run only. `producer_env` is a comma-separated list of NAME=1 pairs for the producers' kill switches (each NAME must end in `_ENABLED`; the turn job's validation step appends them to the job environment and fails the run on anything else), for example `MARKET_PRODUCER_ECB_FX_ENABLED=1`. The propagate input carries `"cadence_exception": "<the operator's ruling>"` beside `producers`: on an apply it opens the producers step and the rows-file capture for that call (the ledger row records the text and the producers covered); on a dry call it is only recorded; `system_state.scrape_cadence` is never touched. A rows-file producer takes `"rowsFile": "src/features/<market|operations>/producers/data/rows/<file>"` inside `producers`. Example: `gh workflow run ci.yml -f only=turn -f stage=propagate -f chain=false -f mode=apply -f producer_env=MARKET_PRODUCER_ECB_FX_ENABLED=1 -f input='{"propagate":{"producers":{"only":"ecb-fx"},"cadence_exception":"operator 2026-10-23 ruling 1: population hold lifted for the structured-data producers (rulings-2026-10-11.md)"}}'`.

## Still the operator's, and the default if it is left undecided

| step | what the operator does | default if undecided |
|---|---|---|
| open the window | says when | the old tree keeps serving; nothing is applied |
| 1 | imports the repository in Vercel, enters the environment values, enables the automation bypass | no new tree; nothing changes |
| 1 | creates or confirms the platform-admin test account whose credentials become `LIVE_ADMIN_EMAIL` and `LIVE_ADMIN_PASSWORD` | the admin checks and the admin parity capture are skipped, not failed |
| 2 | 0008 as written or additive-only | as written |
| 4 | rules on duplicate e-mail addresses if the query lists any | 0066 stays unapplied |
| 5 | asymmetric JWT signing keys; the anon key rotation | no change to either |
| 6 | Resend account, DNS records, key | invitations stay copy-link |
| 7 | repoints the domain; pauses the old project | the old tree keeps serving |
| 8 | the UN/LOCODE terms | the five names stay |
| 9 | opens P1 to P7 and ticks them | the runbook stays unticked and P2-17 does not start |
| design | decides each row of `docs/DESIGN-CHANGES-OWED.md` | every row stays open; the build keeps what it built |
