# Parity Baseline

Existing site's parity baseline per docs/PART2-AGENT-PLAN section 7. Captured 2026-10-15 from old-repo workflow parity-baseline.yml run 38819128509 against commit 5746eeccc. Viewports: 1280x900 and 375x812. 18 of 19 routes captured. Route `community-group` NOT captured (discovery found no matching link on /community for smoke account; to be captured before slice P2-16). All email addresses in JSON replaced with smoke@example.invalid (64 replacements). Display user: Dietl / Rockit. The compare gate (tests/parity/compare.mjs) arrives with slice P2-09.


PNG files are kept only for the four signed-out routes; signed-in routes keep their accessibility JSON only (account details must not enter a public tree); the full capture stays in the old repo's run artifact 38819128509.

Personal identifiers in the JSON were replaced (64) with smoke@example.invalid / smoke; the product address privacy@carosledge.com is unchanged.

## Recapturing the baseline

Counts and data-derived option sets drift (the compare gate treats integer runs in control and heading names as data), but the old site's look and structure can also change, and a deliberate refresh is a PR of its own:

1. Dispatch the workflow `CI` (Actions, Run workflow) with input `only` = `baseline` (it then runs that job alone; with `only` empty a dispatch runs every job except `baseline`, and the `turn` job writes dry rows to the production ledger) and input `routes` (default `all`). Job `baseline` captures https://carosledge.com with the LIVE_SMOKE_* account and uploads artifact `parity-baseline-<run id>`. It never runs on push or pull_request.
2. Download the artifact; replace the files under `tests/parity/baseline` (keep PNGs only for the four signed-out routes, replace every e-mail address with smoke@example.invalid as above).
3. Update the capture date and the run id in this README, commit, open a PR. Compare then runs against the new baseline in the same PR's parity job.

The job captures with `--site old`: a route that has `oldPath` in routes.json is captured there (the `dashboard` record at "/", where the old dashboard lives; the old site answered 404 at /dashboard), under the same record name. The new site keeps `path`.

The `baseline` job is dispatch-only and has not been run yet; compare treats integer runs in names as data.
