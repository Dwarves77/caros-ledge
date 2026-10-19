# Production visual pass, 2026-10-18

Source: dispatch of the `screens` job (PR 47) against https://carosledge.com, run 39180278685, artifact `screens-39180278685`: 19 routes at 1280x900 and 375x812 (index.json lists them). Reviewed by looking at the PNGs: the detail pages (regulation, operations, research, market) and the dashboard, regulations, community, search, settings and map pages at 1280, and the regulations and operations-detail pages at 375. The other PNGs were not looked at one by one; their records (heading, final path, status) were read from the JSON. Status tokens: [CONFIRMED] seen in a capture or measured, and traced to code; [HYPOTHESIS] seen but not traced or not reproduced; [REFUTED] looked wrong, found by design.

## Capture result (exit 1)

- [CONFIRMED] `admin`: not captured. Sign-in of the LIVE_ADMIN account timed out (`page.waitForURL: Timeout 60000ms exceeded`, waiting for the URL to leave /login). The member account signed in. The cause is not visible from the artifact (the credentials, an account the sign-in does not accept, or a post-login route that never loads); nothing in the repo can fix it from here. Owed: the coordinator checks the LIVE_ADMIN_* secrets; the job reports it as it did.
- `community-group`: skipped, "baseline owed" (no old-site baseline); expected.
- Every other route captured (`ok`).

## Defects

### V-1 [CONFIRMED] A connection's whole title is printed (no clamp), any length
- Route and viewport: every detail page that has a connections strip (regulation, operations, research, market detail); measured at 375 and 1280. A record title of hundreds of words is printed whole (the operator's screenshot).
- Old page: ItemConnectionsCard's masthead variant clamped the title to two lines (old_repo/src/components/shell/ItemConnectionsCard.tsx lines 40-50, 69-99).
- Cause: `.cl-detail-link-title` has `overflow-wrap` only: src/ui/base.css:787; rendered by src/ui/detail/ItemConnections.tsx:25 and src/features/market/ui/MarketDetailView.tsx:65 (same class).
- Reproduced red on a fixture with a 600-character title: 24 lines at 375, 6 at 1280.
- Fix: clamp in the shared class (two lines; the full title stays in the link's `title`). Test: regulations-smoke measures every connection title at 375 and 1280 on that fixture (at most two lines).

### V-2 [CONFIRMED] The connections strip is full-bleed
- Route and viewport: research-detail and operations-detail at 1280 (any detail page with connections). The strip's label and titles start at the card's edge (x=289) while every block above starts 20 px in (x=309).
- Cause: the masthead slot has a top rule and no padding (src/ui/base.css:406) and the strip adds none (src/ui/detail/ItemConnections.tsx:33-40). The old strip was a padded grid of cards with a 2 px brand edge and a clamped title (same old file).
- Fix: strip padded 14/20/16, links in an auto-fill grid with the brand edge (base.css, ItemConnections.tsx). Test: the same regulations-smoke check requires at least 16 px of inset.

### V-3 [HYPOTHESIS] An empty band between the timeline and the connections list
- Operator's operations detail page. In the captured operations item (india-regional-operations-profile) at 1280 the gap from the timeline callout to the strip is 18 px, and at 375 the first screen ends before the strip; the capture is one viewport tall (V-7), so the lower part of the 375 page was not seen. Not reproduced on the fixture either (14 px). It may be specific to the item the operator opened (for example a timeline with passed milestones in the vertical layout, src/ui/base.css:690-697, 14 px of padding under each marker).
- Not fixed. The regulations-smoke check added for V-1 and V-2 also asserts the gap between the strip and the block above is at most 48 px, so the class is caught wherever a fixture shows it. A recapture with whole-page screenshots (V-7) of the operator's item will confirm or refute it.

### V-4 [CONFIRMED] A page frame with no rail still reserves the 300 px rail column
- Route and viewport: community at 1280 (content 620 px wide, 368 px of blank space on its right; room tiles clip their names, "GLOBAL", "UNITED KINGDO", "ASIA-PACIFIC"; the "GLOBAL ROOM" heading collides with its meta text; "NEW POST" wraps to three lines). Also any other rail-less PageFrame at 1280 and above.
- Cause: `.cl-page-frame` is always a two-track grid (`minmax(0,1fr) 300px`), src/ui/base.css:487; src/ui/shell/PageFrame.tsx rendered it with no rail child. The old frame had the same grid but folded at 1280 inclusive; the new fold is 1279 by ruling, so a 1280 viewport got the empty track.
- Fix: a frame with no `rail` is one column (`cl-page-frame--solo`). The obligation register passed its side note as a second child; it is now the `rail` prop (same DOM order). Test: measure.mjs (run by every UX smoke) fails a page frame with more tracks than children; red on the Community fixture at 1440 (15 failures), green after.
- Look change to report: Community (and any other rail-less frame) is wider at 1280 and above. The previous rendering was visibly broken; for a ruling if wanted.

### V-5 [CONFIRMED] "1 connections"
- research-detail at 1280: "1 source . 1 connections".
- Cause: the template string `${p.connectionRows.length} connections` in src/features/research/ui/ResearchDetail.tsx:97 and src/features/operations/ui/OperationsDetail.tsx:114.
- Fix: `pluralize` from core/shared (both). Not a control or heading in the baseline.

### V-6 [CONFIRMED] The dashboard route is captured at a path that does not exist
- dashboard: HTTP 404 "This page doesn't exist" at /dashboard on production in both viewports. The dashboard is at `/` (src/app/page.tsx; nav-model.ts:36). tests/parity/routes.json:12 listed `/dashboard` with `oldPath "/"`, so the frame-only parity gate compared the shell of a 404 page and the dashboard was never looked at.
- Fix: routes.json path `/`. Test: tests/parity/routes-exist.test.mjs fails any fixed path or discovery list in routes.json that has no page under src/app.

### V-7 [CONFIRMED] The screenshots were one viewport tall
- Every record has document_height equal to the viewport height: the shell scrolls inside `<main>`, so `fullPage` never saw the page below the fold.
- Cause: tests/parity/capture.mjs took `fullPage` of the document.
- Fix: with `--fresh` (the screens job) the helper `wholePageScreenshot` grows the viewport to the tallest scroll box before the PNG; the parity capture is untouched. Test: ux-smoke asserts the PNG of /privacy at 375 is as tall as the page inside `<main>`.
- Consequence for this pass: the lower halves of the pages were not seen. A new dispatch of the screens job after the merge gives the whole pages.

### V-8 [REFUTED] The Impact column draws missing-glyph boxes
- regulations and search lists: twelve small outlined boxes in four groups in every row. They are the unscored meter's dashed segments (src/ui/ImpactMeter.tsx, "unscored draws dashed outlines"), by design; the "NEEDS MORE DATA" line beside them is the same state. That every immediate row is unscored is data, not display.

### V-9 [HYPOTHESIS] List rows give the title a narrow column at 1280
- regulations and search at 1280: titles truncate at about 110 px ("Mexico SEMAR...", "Regulation (EU) ...") with free width elsewhere in the row. Possibly the RowTable column template. Not traced; the baseline holds no 1280 row measurement to compare.

### V-10 [HYPOTHESIS] Settings section headings wrap beside a long meta line
- settings at 1280: "FREIGHT SECTORS" breaks onto two lines because its right-hand text takes the width; the segmented controls under Dashboard defaults wrap to a second row. Likely the same family as the Community heading collision (V-4); not traced.

### V-11 [HYPOTHESIS] Map coverage gaps read "0 of 56", "0 of 27" ...
- map at 1280. A zero may be real coverage, or a failed or sourceless read drawn as a count (INV-263). Not traced.

## Owned by P2-15j (not duplicated here)

The region landmark order, the theme brief's missing list items and the Spec09 panels' missing Request coverage controls are structure, not visible in the viewport captures; nothing in this pass touches them.

## Nothing else seen

The login, signup, privacy and home (signed out, redirected to /login?redirect=%2F) captures are consistent with the baseline records. The one 429 on research-detail (bootstrap) was retried by the capture's throttle handling.
