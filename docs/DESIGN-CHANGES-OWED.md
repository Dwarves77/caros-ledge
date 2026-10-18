# Design changes owed

Where the build departs from an artboard because the system needs something the artboard does not draw, or because a standing law moves a measure. An artboard fixes look (layout, spacing, type, colour); it never fixes data structure or behaviour, so when the two disagree the build follows the system and the departure is listed here (standing rule 20; the operator's wording is "if you ever have a part of this build that doesn't match the design, then we need to change the design to fit those systems and tools"). The operator decides each item as a look decision: **accept** (Claude Design redraws the artboard to match the build), **redraw** (the build changes to the artboard and the reason it moved is answered another way) or **defer**. Nothing here changed the look silently.

Compiled from the DESIGN CHANGES OWED lists of the merged PR bodies, PR 16 onward (PRs 1 to 15 and 18 to 20, 22, 23, 26, 29, 30, 32 to 35 and 37 carry no list). One row per change; a change several PRs name is one row naming them all. Status of every row below: **open**.

Rulings cited: **law 2** is `docs/design/ux-laws.md` law 2 (interactive targets) and the operator's 2026-10-16 standard of 44 px on every control; **INV-262** every headline figure carries its source's rating; **INV-263** a failed read is stated with Retry, never an empty list or a zero; **ruling 10** is BUILD-PLAN-2026-10-12 ruling 10 (the five fact-document sections that never displayed now do); **rule 2** never fabricate (no number where none is known).

| # | PR | artboard | what the build does that the artboard does not draw | ruling | status |
|---|---|---|---|---|---|
| 1 | 16 P2-09 | 16 (auth) | fields and buttons are 44 px, not 36 px | law 2 | open |
| 2 | 16 P2-09 | 02 (list rail, Filters card) | facet rows keep a 24 px target on a 32 px pitch on desktop (24 px with 8 px clear); 44 px on the phone as before | law 2 | open |
| 3 | 16 P2-09 | 22 (list row) | timeline marker labels are no longer keyboard stops (B-1965); the Full schedule action is the keyboard route | law 2, B-1965 | open |
| 4 | 16 P2-09 | phone timeline | the labels reflow in the same markup as the wide form (no second DOM); the look is unchanged, spacing re-derived from the old values | no second DOM (PR 16) | open |
| 5 | 16 P2-09 | none (shell-list.md) | /privacy and the auth routes render without the signed-in chrome; no artboard draws a chromed privacy page | shell-list.md | open |
| 6 | 16 P2-09 | none | the 503 page "The sign-in service is unavailable" (IMP-015) | INV-263 | open |
| 7 | 16 P2-09 | command bar | a failed search shows an error note with Retry; the Ask button is drawn only when an assistant is mounted | INV-263 | open |
| 8 | 16 P2-09 | watch toggle | a failed save shows a visible line under the control | INV-263 | open |
| 9 | 16 P2-09 | card foot strips | footer links grow to 44 px targets inside the same strip height | law 2 | open |
| 10 | 17 P2-09b | 01 (nav card) | rows are 44 px targets (pitch 46), not about 42 | law 2 | open |
| 11 | 17 P2-09b | 01 (nav cap) | no band split while counts are unknown; the artboard draws an equal split | rule 2, INV-263 | open |
| 12 | 21 P2-02b | 14 (Account), 15 (Settings) | every control meets law 2: segmented controls, toggles, sector and jurisdiction chips, the Select all and Clear links and the card-foot links are 44 px where the artboards draw 24 to 32; the chips are the kit ChoiceChip | law 2 | open |
| 13 | 21 P2-02b | 14 (Account) | the four profile fields carry their visible labels as accessible names (visible text unchanged) | accessibility | open |
| 14 | 21 P2-02b | 15 (Settings) | the section index has five sections (General, Notifications, Data, Archive, Help); Saved searches and the Data summary are not built; the rail card "Data & supersessions" lists Supersession history and Archive | IMPROVEMENTS 1 (saved views replace saved searches) | open |
| 15 | 21 P2-02b | 15 (Settings) | the Freight sectors card saves by itself and shows a failure note with Retry inside the card | INV-263 | open |
| 16 | 21 P2-02b | 17 (Onboarding) | the wizard copy no longer claims the choice "scopes every count, tile and row"; the steps are one column at max-width 520 and the choice chips are 44 px; the preview shows a failure note when the counts did not load | rule 2, law 2, INV-263 | open |
| 17 | 21 P2-02b | 16 (auth frame) | the "Privacy" link in the frame's disclaimer is 44 px | law 2 | open |
| 18 | 21 P2-02b | 14 (Account, members) | the invite control shows for admins as well as owners (the route allows it); Remove and Ban are one dialog (the kit Dialog), Ban asks for the typed name | behaviour follows the route | open |
| 19 | 21 P2-02b | none | no artboard draws the archive dialog, the tag popover, the invitation landing or the failure pages; they are built from the kit and need a design | rule 20 | open |
| 20 | 24 P2-11 | 04 (Market headline) | a rating chip on every headline card, the sparkline and YoY slots, a scroller for the headline row | INV-262 | open |
| 21 | 24 P2-11 | 04 (Market) | the sort link is the kit's 24 px (not changed here) | law 2 | open |
| 22 | 24 P2-11 | market matrix | the PR lists "40 px matrix cells" as owed; law 2 asks 44 (compare item 35) | law 2 | open |
| 23 | 24 P2-11, 27 P2-10, 31 P2-12 | detail pages | the five fact-document sections that never displayed now do, with index entries S11 to S18 | ruling 10 | open |
| 24 | 25 P2-13 | watch menu, ask panel, portfolio forms | controls are 44 px on the short axis | law 2 | open |
| 25 | 25 P2-13 | Dashboard | the foot text states the real window (90 days in build mode, 7 with a cadence) and drops "old band to new band" | rule 2 | open |
| 26 | 25 P2-13 | Dashboard, Assistant | the "Create shared watchlist" button and the sample suggestion questions are not built (unverifiable); the "community discussions" promise is removed | rule 2, Community is social only | open |
| 27 | 25 P2-13 | watchlist | the workspace tags facet is absent (interface gap, no hook in the tree) | rule 20 | open |
| 28 | 27 P2-10 | Map | 44 px rows in the jurisdiction register and in the obligation register links | law 2 | open |
| 29 | 27 P2-10 | register | below 768 the register stacks themes and band under the name | responsive | open |
| 30 | 27 P2-10 | list pages | the saved-views control is new (IMP-064) | system need | open |
| 31 | 27 P2-10 | Map | the map names its OpenStreetMap attribution | licence | open |
| 32 | 28 P2-14 | none | the console's Parts tile and /admin/parts gallery are system additions (IMP-060) | rule 20 | open |
| 33 | 28 P2-14 | console issues rail, flags tab | the rejections count is a fourth row on the issues rail and a third badge on the flags tab | system need | open |
| 34 | 28 P2-14 | coverage matrix | shows country names from the platform's region names and the bare code for sub-national codes | rule 2 | open |
| 35 | 31 P2-12 | 08 (Operations matrix) | matrix cells and rows are 44 px against the artboard's 40 (waived as `operations-matrix-row-height`) | law 2 | open |
| 36 | 31 P2-12 | 08 | a seventh dimension grid, carbon intensity | system need | open |
| 37 | 31 P2-12 | 08 | the spec-09 sections with index entries, and a Recalculated figures rail card | system need | open |
| 38 | 31 P2-12 | 06 (Research) | a credibility legend; "Why unscored" becomes "How impact is read" | rule 2 | open |
| 39 | 36 P2-16 | 12 (Rooms) | the group-header, prompt-chip and member-row controls are built at 44 px; starter prompts are 44 px pills | law 2 | open |
| 40 | 36 P2-16 | 12 (Rooms) | the two prose links ("workspace invitation", "not a verifier") get a 24 px target where the artboard draws 15 px text | law 2 | open |
| 41 | 36 P2-16 | 12 (Rooms) | the Pending invitations and Welcome back cards above the rooms (the old page never drew them; not on the artboard) | system need | open |
| 42 | 36 P2-16 | 12 (Rooms) | a failure note with Retry for every block that can fail | INV-263 | open |
| 43 | 36 P2-16 | 12 (Rooms) | a "Signed off" chip distinct from the "Verified" mark (the artboard draws one check for both) | rule 2 | open |
| 44 | 36 P2-16 | none given | the Community sidebar at phone width is the platform drawer's content, not a second sidebar | rule 20 | open |
| 45 | 36 P2-16 | none given | the notifications bell sits top right of the content column on every page (no bell in the shell chrome artboards) | rule 20 | open |
| 46 | 36 P2-16 | none given | the moderation queue's Take action disclosure and confirm dialogs | rule 20 | open |
| 47 | 36 P2-16 | none given | the directory and discover pages | rule 20 | open |
| 48 | 36 P2-16 | none given | region tabs only on /community/browse | rule 20 | open |
| 49 | 36 P2-16 | 12 | no mute state is drawn: the Muted chip, the three duration buttons (1, 7, 30 days) and the refusal sentence naming the date | rule 20 | open |

Items 44 to 48 were given no artboard number by the lane; each needs one assigned before the operator decides it.
