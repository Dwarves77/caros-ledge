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

## Recaptured 2026-10-17 (workflow run 39006645900)

Recaptured from https://carosledge.com by the `baseline` job (dispatch of `CI` with `only=baseline`, run 39006645900, repo commit ede4a49; the old site's own commit is not recorded). The `dashboard` record is the old site's "/" (the old /dashboard answered 404). Detail routes were discovered on the live data: regulation-detail /regulations/g14, market-detail a market item; community-group is skipped (/community is frame-only, gates.frame). `admin` is the 2026-10-15 capture, kept: the recapture cannot sign in as an admin. Sanitised as before: every e-mail address became smoke@example.invalid (privacy@carosledge.com kept) and the account name token became smoke; PNGs are kept for the four signed-out routes only. Against the main capture of run 39006634324 the per-route state is unchanged (the only differences: the dashboard frame route now lists its body landmarks as "checked at full", and the pixel deltas on the four signed-out routes moved by under 0.2 points).

## Detail routes added 2026-10-18 (workflow run 39086884529)

`research-detail` (a research item) and `operations-detail` (an operations profile) captured from https://carosledge.com by the `baseline` job (dispatch of `CI`, `only=baseline`, `routes=research-detail,operations-detail`, run 39086884529, ref slice/p2-ci8). Both viewports; JSON only (PNGs not kept for signed-in routes). Sanitised as before: e-mail address became smoke@example.invalid and the account first-name token became smoke. Other routes are unchanged; `community-group` is still owed (the member account holds no group).
