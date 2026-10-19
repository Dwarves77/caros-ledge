# Design changes owed: rulings, 2026-10-18

Rulings proposed by Claude Design from the UI build-out (artboards 00 to 22, 375/1280 canvas), delivered by the operator 2026-10-18. Default: **accept**, meaning the artboard is redrawn to match the build. The build changes only where the build breaks one of the operator's own standards. Three items need the operator to decide.

## Summary
- **Accept: 48 items.** Claude Design redraws the artboards; the build does not change.
- **Redraw build: 2 items (21, 40).** The build moves to 44 px.
- **Operator decision: 3 items (2, 27, 22 merged into 35).**
- **New artboard numbers:** 23 Kit overlays, 24 Failure pages, 25 Admin parts. Items 44 to 48 go to 12 (Rooms) variants and 01 (shell chrome).

## Blanket rulings
- **Law 2 (44 px):** accept everywhere the build already meets 44 px: items 1, 9, 10, 12, 17, 24, 28, 35, 39. The artboards are redrawn with 44 px hit areas. The visual type stays the same; the extra height comes from padding.
- **INV-263 (failure note + Retry):** accept every item: 6, 7, 8, 15, 42, 50, 51, 52, 53. All of them use one shared part, *FailureNote* (sentence + Retry, inline in the block that failed), which is added to sheet 00 §0.5.
- **Rule 2 (never fabricate):** accept every item: 11, 16, 25, 26, 34, 38, 43.
- **Ruling 10:** accept item 23. The detail indexes gain S11 to S18. Artboard 22's nested index carries them.

## Per-item rulings
| # | ruling | artboard action |
|---|---|---|
| 1 | accept | 16: fields and buttons 44 |
| 2 | **operator** | Conflict: the build keeps 24 px facets on desktop, but the operator standard is 44 on every control. Option A: accept 24 on a 32 px pitch (passes WCAG 2.5.8). Option B: 44 px rows, which make the Filters card about 35% taller. Claude Design recommends A, recorded as a waiver `facet-row-desktop`. |
| 3 | accept | 22: Full schedule is the keyboard route; marker labels are not focusable |
| 4 | accept | phone timeline: no visual change; note in README |
| 5 | accept | new frame 16-privacy-unchromed-375/1280 |
| 6 | accept | 24-failure-503-signin |
| 7 | accept | command bar: FailureNote state; Ask button conditional |
| 8 | accept | watch toggle: error line state |
| 9 | accept | card foot strip: 44 px link hit area, same strip height |
| 10 | accept | 01: nav rows 44, pitch 46 |
| 11 | accept | 01: cap drawn with no split while counts are unknown |
| 12 | accept | 14, 15: controls 44; chips are the kit ChoiceChip |
| 13 | accept | no visual change |
| 14 | accept | 15: five sections; rail card "Data & supersessions" |
| 15 | accept | 15: sectors card FailureNote state |
| 16 | accept | 17: new copy, one column at max 520, 44 px chips, preview failure state |
| 17 | accept | 16: Privacy link 44 |
| 18 | accept | 14: invite shown to admins; one Remove/Ban dialog drawn on 23 |
| 19 | accept | 23-archive-dialog, 23-tag-popover, 24-invitation-landing, 24-failure-* |
| 20 | accept | 04: rating chip, sparkline and YoY slots, headline scroller |
| 21 | **redraw build** | Sort link moves to a 44 px hit area (visual 24). Kit change. |
| 22 | merged into 35 | Matrix cells are 44 on Market and Operations |
| 23 | accept | detail indexes S11 to S18 |
| 24 | accept | watch menu, ask panel, portfolio forms: 44 |
| 25 | accept | Dashboard foot copy states the real window |
| 26 | accept | Dashboard and Assistant: remove the button, sample questions and community promise |
| 27 | **operator** | Tags facet. Option A: remove it from the artboard. Option B: keep it drawn and open a build ticket for the hook. Claude Design recommends B, because tags are on the roadmap. |
| 28 | accept | Map registers: 44 px rows |
| 29 | accept | register frame at 375: stacked |
| 30 | accept | saved-views control on list mastheads (02, 03, 06, 08) |
| 31 | accept | Map: OSM attribution, bottom right |
| 32 | accept | 25-admin-parts, plus a Parts tile on the console |
| 33 | accept | console: fourth issues row, third flags badge |
| 34 | accept | coverage matrix: names, plus bare codes for sub-national regions |
| 35 | accept | 08 and 04 matrices: 44 px. The waiver `operations-matrix-row-height` retires with the baseline recapture from the new site (coordinator note: not deleted while the baseline is the old site). |
| 36 | accept | 08: seventh grid, carbon intensity |
| 37 | accept | 08: spec-09 sections plus the Recalculated figures rail card |
| 38 | accept | 06: credibility legend; "How impact is read" |
| 39 | accept | 12: 44 px controls; prompt pills |
| 40 | **redraw build** | Prose links get a 44 px hit area (visual 15 px text stays) |
| 41 | accept | 12: Pending invitations and Welcome back cards |
| 42 | accept | 12: FailureNote per block |
| 43 | accept | 12: Signed off chip, separate from the Verified mark |
| 44 | accept, **12** | 12-community-drawer-375 |
| 45 | accept, **01** | shell chrome: bell top right of the content column |
| 46 | accept, **12** | 12-moderation-action + confirm dialogs (on 23) |
| 47 | accept, **12** | 12-directory, 12-discover |
| 48 | accept, **12** | 12-browse with region tabs |
| 49 | accept, **12** | 12-muted state: chip, 1/7/30 buttons, refusal sentence |
| 50 | accept | 01, 02: FailureNote above the brief or list |
| 51 | accept | 03, 06, 08: "Counts unavailable", blank tiles |
| 52 | accept | 08: Coverage gaps FailureNote |
| 53 | accept | 04, 05, 07, 09: Inferences failure state |
