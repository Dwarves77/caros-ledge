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

---

# Second pass, 2026-10-19

Source: screens run 39184596236 against production after the first-pass fixes (artifact `screens-39184596236`, whole-page PNGs: 1280-wide pages 900 to 16000 px tall, 375-wide pages up to 16000 px). index.json: member sign-in ok; **admin sign-in failed again** (`page.waitForURL: Timeout 60000ms exceeded`), so `/admin` was not captured; `community-group` skipped (baseline owed); every other route `ok`. Method: every PNG was cut into slices and looked at (full resolution for the detail pages, lists, map, settings and community; half-scale to 0.6-scale contact sheets for the remainder and for the 375 captures). market-detail and research-detail at 375, and market-detail at 1280, are cut at the capture's 16000 px ceiling.

## First-pass fixes, read on production

- V-1 [CONFIRMED fixed]: operations-detail at 1280 and 375 shows connection titles clamped to two lines with an ellipsis ("ASEAN Transport Strategic Plan 2016-2025 and Regional...").
- V-2 [CONFIRMED fixed]: the strip is inset 20 px, a three-column card grid at 1280 with the brand edge, one column at 375, "16 MORE CONNECTIONS BELOW" under it.
- V-4 [CONFIRMED fixed]: community at 1280 is 948 px wide next to its 300 px rail; room tiles read in full ("ASIA-PACIFIC ROOM", "UNITED KINGDOM ROOM"), "GLOBAL ROOM" and "NEW POST . GLOBAL" on one line.
- V-6 [CONFIRMED fixed]: the dashboard is captured at `/`, HTTP 200 (the member's brief title).
- V-7 [CONFIRMED fixed]: whole pages captured. Residual: the 16000 px ceiling cuts the longest pages.

## V-3 [REFUTED for the captured item] Empty band between the timeline and the connections

Operations detail at 1280: the next-milestone callout ends at y=700, the connections rule is at y=718 and its label at y=735: 18 px plus the strip's own 14 px padding. At 375 the callout ends at y=1343 and the strip's rule is at y=1360. There is no empty band under the timeline on india-regional-operations-profile in either viewport. The band the operator saw is not in this item; the 48 px assertion added in the first pass stays as the guard. (The images do show a 46 px gap under "Show more" in the Exposure block at 1280, above the timeline: that is a 44 px control, `.cl-exposure-expand`, src/ui/base.css:361, set by the law-2 floor; not a defect.)

## V-9 [CONFIRMED, look ruling owed, not changed] Narrow title column on lists at 1280

regulations, research, operations, dashboard and search at 1280: titles end at about 115 px ("Mexico SEMAR...", "NEEDS I" under a research title). Cause: `.cl-list-row` is a fixed grid, `3px 56px 1fr 88px 84px 76px 40px 44px` with 14 px gaps (src/ui/base.css:250 and :252): 501 px of fixed columns leave 119 px for the title in the 620 px column that remains beside the 300 px filter rail. The grid is the artboard's and the old file's (old_repo/src/components/ui/ListRow.tsx lines 8 and 138, identical), so this is not a regression. Fixing it means changing the row grid, a look change for a ruling: on DESIGN CHANGES OWED (list row at 1280 with a rail: drop the Impact or Timeline column, or fold the rail earlier). Parity measures row heights at 375 only; nothing changed here.

## V-10 [CONFIRMED] Section titles wrap beside a long, unbreakable aside

settings at 1280 ("FREIGHT SECTORS" on two lines beside "6 SELECTED . FILTERS YOUR DEFAULT VIEW, BRIEFINGS AND RELEVANCE"). The same rule, run over the fixtures, also found admin Coverage: "Coverage matrix . 2 places" wrapped at 768 and 1280 while 238 px of title fit in 838. Cause: `.cl-section-head2` was a single flex row with a no-wrap aside, so the title wrapper shrank first (src/ui/base.css:54-59). Fix: the head wraps (`flex-wrap`), the title wrapper keeps its width, the aside drops under it, right aligned. Test: measure.mjs fails any section title that wraps while its text fits on one line; red on admin Coverage before the fix (2 failures), clean after.

## V-11 [REFUTED as INV-263; data question open] "0 of 56" on Coverage gaps

A failed read cannot draw a zero: `readRegionCoverage` throws (src/features/regulations/map/region-coverage.ts), the route turns that into `null` (route.tsx:26) and the rail then draws "The coverage snapshot did not load" (MapPage.tsx:73-74). So the zeros are the output of a successful read: no active, public source row names any jurisdiction code of those regions (US sub-national 0 of 56, EU member states 0 of 27, and so on), because `sources.jurisdictions` holds the supranational or country code. Whether that equals the real registry is a database question; this lane may not read the database. For the coordinator: one count query of `sources` by jurisdiction code answers it.

## New defects

### V-12 [CONFIRMED] Timeline dates are cut at 375
- operations-detail at 375: the vertical timeline shows "2025-0...", "2030-0...", "2047-0..." (the date column is 62 px with 8 px padding, the date needs 73 to 75).
- Cause: src/ui/base.css:693-694 (`grid-template-columns: 62px 14px 1fr`, `.cl-tl-date { width: 62px }`) with the nowrap ellipsis of base.css:339.
- Fix: 84 px date column, the rail line moved to match (base.css:692). Test: measure.mjs fails any `.cl-tl-date` whose text is wider than its box; red on the regulations detail and record fixtures at 375 and on the ux fixtures (21 failures), clean after.

### V-13 [CONFIRMED] A theme card stretches to its longest member title and is cut off
- regulations, research and operations lists at 1280: the "Themes across the corpus" card is about 548 px wide, its member titles run off its right edge with no ellipsis, and the strip clips it.
- Cause: `.cl-theme-card { flex: 0 0 260px }` has `min-width: auto`, which resolves to the unbreakable member title's width: src/ui/base.css:532 (the ellipsis rules at :541 never apply).
- Fix: `min-width: 0; overflow: hidden` on the card. Test: measure.mjs fails a theme card wider than 262 px; the surfaces fixture's member title is now 130 characters; red (768 research: 722 px) before, clean after.

### V-14 [CONFIRMED] The Regulatory map's masthead and the obligation register's masthead have no page gutter
- map at 1280 and 375: the masthead card runs from the nav edge to the right window edge (x=252..1280) while the cards below it start 40 px in; the register page has the same bare call.
- Cause: `<Masthead>` drawn without the `cl-list-surface-masthead` wrapper: src/features/regulations/map/route.tsx:34 and src/features/regulations/pages.tsx:134.
- Fix: wrapped. Test: tests/ui/masthead-wrapped.test.mjs fails any `<Masthead` in src with no gutter wrapper in the two lines above it (a short list of exempt files, each with its reason); red on exactly those two lines before the fix.

### V-15 [CONFIRMED] Float noise on recalculated figures
- operations at 1280, "Recalculated figures" rail: "13.209999999999999 gCO2e/tonne-km", "3.5300000000000002", "16.119999999999997", "1278.350000000001" (and "(was 51.58)" beside them).
- Cause: `${f.value}` and `${f.previous}` printed raw: src/features/operations/ui/Spec09Panels.tsx:86 and :97 (the helper `money`).
- Fix: `formatFigure` (src/core/shared/dates.ts: thousands separators, at most six decimals). Test: tests/core/shared.test.ts (the four values above).

### V-16 [CONFIRMED] A fact card's provenance column carries a whole paragraph, and its lead column a bold sentence
- market-detail and regulation-detail at 1280: a card whose paragraph quotes several people or passages, each followed by its own "Source:" line, shows a 40-line provenance column of raw text with literal `**` and `*Source:` marks; cards open with a 132 px display-type lead made of a whole bold sentence ("Trend 1 - Packaging Design: Regions are formalizing definitions of recyclability.") or a name ("California SB 343").
- Cause 1: the citation pattern started at the FIRST "Source:" and ran to the end of the paragraph, so everything after it became the issuer (src/core/detail/fact-model.ts, `SOURCE_RE` in classifyParagraph and extractProvenance). Cause 2: `figureLeadFor` took any bold run that holds a digit as the "figure" (fact-model.ts:149-155; the old file did the same, old_repo/src/lib/detail/fact-card-model.ts:278-295).
- Fix: the citation is the LAST "Source:" to the end (earlier passages stay in the claim); a figure lead must open with a digit or a currency or comparison sign and be at most 24 characters. Tests: two new tests in tests/detail/pure.test.ts, red against the old code (2 failures), green after. Parity: the control count per card is unchanged (one source link per card); the link's host is the last citation's, which is the card's own source.

### V-17 [CONFIRMED] The Recalculation notices card has no page gutter on a regulation page
- regulation-detail at 1280: the card runs x=252..1280 and touches the card above it, while "How this regulation reaches you" is inset.
- Cause: src/features/regulations/DetailView.tsx rendered `<NoticesRail />` as a bare sibling of the page wrapper (the other four detail pages put it inside their detail layout).
- Fix: the rail sits in `cl-detail-wrap`. Test: measure.mjs fails a `[data-notices-rail]` card closer than 16 px to either window edge; red on the regulations detail and record fixtures (1024 and 1280) before the fix, clean after.

### V-18 [HYPOTHESIS] Settings leaves its right column empty below the briefing card
- settings at 1280: after the briefing-schedule card the main column stays 620 px wide with 340 px blank to its right for the rest of a 3400 px page. The rail layout is the old page's (a rail card at the top, long forms below); not traced further, no change.

### V-19 [HYPOTHESIS] Assignments card: a label crowds the line above it
- regulation-detail at 1280: "ASSIGN TO" sits directly under "Nobody is assigned to this item yet." with no gap. Minor; not traced.

### Tooling note
- The screens job's 16000 px ceiling (SCREEN_MAX_HEIGHT in tests/parity/capture.mjs) cuts the longest pages; Chromium's own limit is 16384. A tile-and-stitch capture would lift it; not done (the pages affected are long by data, not by layout).

## Owned by P2-15j

The region landmark order, the theme brief's missing list items and the Spec09 panels' missing Request coverage controls are structure; none is visible in the images.
