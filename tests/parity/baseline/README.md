# Parity Baseline

Baseline captured from the NEW production carosledge.com, run 39193537000, repo commit deb1f6df198162dbfdccb0cb9e57e4755cdc37de, date 2026-10-19; the old-site baselines of 2026-10-15/17 (and the 2026-10-18 detail routes) are superseded. Viewports 1280x900 and 375x812. 19 of 21 routes captured (ok): home, login, signup, privacy, dashboard, regulations, regulation-detail, market, market-detail, research, research-detail, operations, operations-detail, map, search-emissions, watchlist, community, settings, profile. Skipped: `community-group` (baseline owed: the member account holds no group) and `admin` (the baseline job holds no admin sign-in; admin routes gate on the deployed preview; the old-site admin files are removed). Sanitised: every e-mail address became smoke@example.invalid (privacy@carosledge.com kept) and the account name token became smoke (32 replacements); display user Dietl / Rockit is kept. PNGs are kept for the four pixelExact signed-out routes only; the full capture stays in the run artifact parity-baseline-39193537000.

The look rulings that waived differences from the old site (44 px law 2, facet-row-desktop, SEC-5 and the rest) now live as text in `rulings` of tests/parity/approved-changes.json; `approved` is empty because capture and baseline are the same site. compare ends its report with an `unused waivers:` line; a waiver that covers nothing is deleted.

## Recapturing the baseline

Counts and data-derived option sets drift (the compare gate treats integer runs in control and heading names as data), but the site's look and structure can also change, and a deliberate refresh is a PR of its own:

1. Dispatch the workflow `CI` (Actions, Run workflow) with input `only` = `baseline` (it then runs that job alone; with `only` empty a dispatch runs every job except `baseline`, and the `turn` job writes dry rows to the production ledger) and input `routes` (default `all`). Job `baseline` captures https://carosledge.com with the LIVE_SMOKE_* account and uploads artifact `parity-baseline-<run id>`. It never runs on push or pull_request.
2. Download the artifact; replace the files under `tests/parity/baseline` (keep PNGs only for the four signed-out routes, replace every e-mail address with smoke@example.invalid as above).
3. Update the capture date and the run id in this README, commit, open a PR. Compare then runs against the new baseline in the same PR's parity job.

The job captures with `--site old`: a route that has `oldPath` in routes.json is captured there (the `dashboard` record at "/", where the old dashboard lives; the old site answered 404 at /dashboard), under the same record name. The new site keeps `path`.

The `baseline` job is dispatch-only and has not been run yet; compare treats integer runs in names as data.

