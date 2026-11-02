# Coordinator Status & Handoff Report (`2026-11-01` STATUS-4, batches 1/1b/1c landed)

This file is the canonical handoff status for the coordinator session. Whenever the operator types `coordinator` or `/coordinator`, read this file first alongside `git log -n 10 --oneline` and `git status -s`.

---

## 1. Current Repository State

- **Branch:** `main` at `d8d6419e` at the time of writing; verify with `git log -n 10`.
- **Branch protection:** `enforce_admins=true`; every change via PR; `ci` + `schema` required.
- **Local gates:** pre-push runs the fast profile plus tests mapped from changed modules, once; the passing HEAD is remembered in the git-dir (ruling 55, PR 180). The full matrix runs in GitHub Actions only.
- **Scrape cadence:** `off` (build mode, rule 16). Migrations 0145, 0147, 0148 applied, plus 0149 (PRODUCER-CAPTURE-1); the orphan 0146 row is deleted.

## 2. Merged since 2026-10-30 (PRs 176-209, all MERGED)

- 176 TEST-FIX-1 (f340d401): licence-register golden runs without network.
- 177 LIVE-GATE-1 (9ebfa220): signed-in production DOM gate with armed assertions.
- 178 ENGINE-ORDER-1 (6de7d64a): obligations, events, refs before discovery and patterns.
- 179 LOC-REPIN-1 (422447cf): LIMITS raised for the wave.
- 180 GATES-FIX-1 (e29fb513): local gate remembers its pass; fast + targeted locally.
- 181 OPS-FIX-1 (28051b42): scoped grid queue, own-item mandates (shipped the /market ribbon regression).
- 182 OPS-FIX-2 (0b2151ae): headline series render without an in-window prior.
- 183 ENGINE-JOIN-1 (320294f6): discovery joins on the typed graph; migration 0145.
- 184 LIVE-GATE-2 (ff3267cd): ribbon-complete assertion.
- 185 POOL-FIX-1 (361c605d): extraction pool excludes foreign capture-cited captures.
- 186 UI-RADAR-1 (cd230947): reasons on connections; Flywheel radar.
- 187 THEME-1a (b333f736): re-cluster on the typed graph (ruled run).
- 188 ETS-CLEAN-1 (4dfc2bb8): rescan ff4064ab and 40c05a1e (ruled run; its run went red unnoticed, header overflow).
- 189 JOIN-CHUNK-1 (6d871a58): facts-join chunks 200 ids.
- 190 ETS-CLEAN-2 (0f117135): re-run connect after orphan clean-up (ruled run).
- 191 THEME-CODE-1 (9fe26d04): convergence floor 0.10; retire-orphan-theme-briefs op; migration 0148 applied (ex-0146).
- 192 UI-RADAR-2 (34d5bd7e): pairwise reasons, grouped patterns, named theme chips.
- 193 CONTENT-1 (89505065): Weekly Oil Bulletin briefs, applied.
- 194 (cccbcba7): UI fix, cut-off cards, table overflow, raw ALL-CAPS statute titles.
- 195 CONTENT-1b (39f34ca4): ff4064ab replaced_by 15f63ea9, migration 0147 applied.
- 196 UI-RADAR-3 (55991423): entity display names, instrument titles, obligation evidence.
- 197 THEME-1b (a200dd07): 5 cross-surface theme briefs with sections, 3 orphans superseded.
- 200 HEAL-WALL-1, 201 ADMIT-1 (0 owed readers), 202 OBL-DERIVE-1, 203 LIVE-GATE-3, 204 DRAIN-THEMES-1, 205 GATES-FIX-2, 206 NORMALISE-2, 207 PRODUCER-CAPTURE-1 (migration 0149), 208 REG-BACKFILL-1, 209 LIVE-GATE-3b. Main 0c79977f.

- 211 REG-BACKFILL-1b (+40 src; metadata-refresh route for brief-grade items; opened wave P57 with ruling-70 headroom src 67640 / core 20905 / features 40040), 212 batch 1b (15 refreshes), 213 batch 1 (24 full briefs; stale 25-id test corrected to assert ids = bundle), 214 batch 1c (5 directive briefs + 5 refreshes; brief apply refused by the 30-minute kit cooldown behind the refresh apply), 215 re-run of the 1c brief plan after the cooldown, 216 first-sentence guard fix (OJ-title guard judges the extracted first sentence; red-first), 217 LIVE-GATE-4 arming no-fallback-summary. Main d8d6419e.

## 3. Production facts (coordinator reads, 2026-10-31)

- Production theme_briefs 12/5/3/0 (per THEME-1b closing state).
- Patterns grouped and named; pairwise reasons; developing empty state; what-moves block; Oil Bulletin rows with why text.
- Orphan clean-up DONE by the operator 2026-11-01 (ruling 71): 1,375 dangling item_forward_events refs, 600 dangling obligation_objects refs, 67 orphan obligation entities and the orphan 0146 migration_log row deleted. entity_refs 50,453 (0 orphans), entities 5,473.
- Batches 1/1b/1c landed: 29 full briefs (24 regulations + 5 directives) and 20 metadata refreshes, authored by Sonnet reader lanes from each item's own capture pool; every entry judged by an independent second reader (ruling 60; 20 judges per brief, J05/J24 per refresh). First-pass judge fails: 52 on batch 1, 4 on 1b, 11 on 1c; all revised and re-judged clean; every FACT span verbatim in the pool; every stored forward-event date covered. SQL-verified: 0 Due-next verified items with an empty context field (was 44 at 09:00 UTC). The six operator-named items (6666d5a0, 9ba8b509, 68af8b45, f1488b95, 0b6537ea, 6cdc920f) all carry reader text.
- Truth is derived, not carried (ruling 69): the "8 and 17 owed obligation objects" are refuted; AFIR 5 and FuelEU 12 are complete under the current window rules.

## 4. Live gate assertions

- 12 of 12 armed and passing on production (run 41341590602 on d8d6419e), including no-fallback-summary (armed by PR 217); earlier 11 of 11 (run 41260343379 on 7caadf17): signed-in, no-404, no-raw-ids, rows-have-why, connections-have-reason, reasons-are-pairwise, no-pending-text, own-mandates, scoped-grid, ribbon-complete, radar-present.
- Armed set: signed-in, no-404, no-raw-ids, rows-have-why, connections-have-reason, reasons-are-pairwise, no-pending-text, own-mandates, scoped-grid, ribbon-complete, radar-present, no-fallback-summary.

## 5. Next wave

- RUNS-FIX-1: two item-briefs apply plans in one push collide on the 30-minute apply cooldown (run bundle, honour `options.cooldownMinutes` per plan, or wait out the cooldown) [CONFIRMED].
- LIST-RPC-1: `get_workspace_intelligence_listings` returns why_matters and what_is_it but not what_it_changes; add the column in the next migration [CONFIRMED].
- ENTITY-MINT-1: a `CELEX:` id with a verbatim quote should mint a grounded entity (ADR-054) rather than be refused unless already in the graph [CONFIRMED]. Also: `mode:inland_waterway` token refused (one-line resolver fix) and "No 528/2012" read as a negation by qualification accounting [CONFIRMED].
- Re-derive after batch 1 applies: 061dce37 forward events (pool is the revised UK ETS Order to 1.7.2026; first maritime handback 30 April 2028 absent) [CONFIRMED]; ef8a1268 due date 2027-01-01 derives from a recital target, operative first date is 12 March 2027 [HYPOTHESIS]; b0b883a3 stored claim cites the ship-efficiency recital date [CONFIRMED].
- OBL-DERIVE-2 also probes obligation_objects mis-typing on 9ba8b509, 061dce37, d63b8204, b9692eae [HYPOTHESIS].
- OBL-DERIVE-2 probe: ~4 AFIR and ~7 FuelEU Article duties the `dutyWindows` rules may reject ([HYPOTHESIS], ruling 69); probe against the sentence rules before any write.
- NORMALISE-2b: delete research_assessments #18/#19 once normalise-2 applies; obligation_objects.source_id STALE delete.
- REG-BACKFILL batches 2-44 go to the drain readers (ruling 60); batch 1/1b/1c are DONE.
- PRODUCER-CAPTURE backfill when cadence returns.
- LOC headroom set at wave open per ruling 70 (wave-scoped ceiling; features and fixes never edit loc.mjs mid-wave).

## 6. Standing rules learned 2026-10-31

- Local gates are fast; the full matrix runs in CI only (ruling 55).
- Watch every PR to green and merged; a parked PR is a miss.
- An independent judge reads every authored brief; self-judging is not evidence (ruling 60).
- Rule 3: schema DDL applies via CLI before the dependent code commits; migration numbers are allocated in landing order (ruling 62).
- One vault PR at wave close.
- No content merge between a theme-brief push and its run (ruling 61).

---

## 7. State at close (replaces "Carried backlog" and "Content owed", 2026-11-01)

### Backlog
- REG-BACKFILL selector backlog 1,090 regulations = 884 all-three-empty + 206 partial (1,089 authorable, 1 heal-first); 44 batches of 25 in the selector's order.
- Batch 1 recomposed (operator directive, COO walk-through in 48 h): the Due-next / IMMEDIATE (<= 90 days) regulations rendered above the fold on Dashboard and /regulations. Production read 2026-11-01: 44 verified regulations carry a forward event within 90 days; 24 have all three context fields empty (record grade, one capture each) and 14 brief-grade items have one or two fields empty. Batch 1 = the 24; batch 1b = the 14.
- Batches 2-44 go to the drain readers (ruling 60).
- Joinability entries kept: intelligence_items.severity forms (data decision), derived_values.entity_id, market_series.entity_id, section_claim_provenance source_id/tier, regional_data_facts 75 legacy rows, `J3pat:intelligence_items.jurisdiction_iso` ("GLOBAL" x75, "IMO" x3: JUR-ISO data decision). Count is 21, not 19.
- Judgement drain batches via `/drain` when the drain switch is on.

### Content owed (corrected)
- Visibility check on carosledge.com of released items (research `947e08f3`; regulations `ff95b385`, `7a0ead55`).
- ~~Derive the obligation objects now their instruments are verified: 8 for `ff95b385`, 17 for `7a0ead55`.~~ **[REFUTED 2026-11-01, ruling 69]** 17 was the count of candidates refused `instrument_item_missing` while FuelEU was quarantined (RESUME-2026-10-27:17); today FuelEU has 12 candidates, all registered; "8" has no provenance beyond this line. AFIR 5 and FuelEU 12 are complete; the open [HYPOTHESIS] is carried by OBL-DERIVE-2.
- IEA `947e08f3` re-source: the earlier "Cloudflare page and a stub" was refuted; one wall row among six real captures, now excluded as unusable (HEAL-WALL-1).
- `15f63ea9` R33 versus growing supplied dates (design question).

### Code window items closed this wave
- Derive after verification, truthful derive refusals, wall pages unusable (HEAL-WALL-1), tsc exit 2 fails the fast gate (GATES-FIX-2), patterns kind in joinability, drain-authored themes (DRAIN-THEMES-1). Mode is classifier-or-null, then the instrument's own modes (ruling 65).
- Still open: `themeOf()` keyword fallback (ADR-053/054); `validate_item_provenance` criterion 5 typed `slot_key`; no transition log for `provenance_status` flips; Gate A dates from DB source records.

### Rules in force (vault rulings 41-43 and the repo CLAUDE.md)
- The redesign is the look and baselines follow it.
- A lane pushes once after the full profile is green locally.
- Content runs touch no src; repair, not reject.
- One home per mechanism; no word lists.
- Root cause, never re-run.

---

## 8. Wave P58 (2026-11-01/02): ruling 73 full re-authoring

Ruling 73: no legacy content is evidence; every processed item is re-authored from its own capture pool, independently judged, and flywheel-connected. Ruling 74: every Agent call carries `model` (standing rule 23). Detail: vault session-log addenda 2026-11-02 (i) and (j).

### Counts: new-system vs legacy per surface (final, read-only SQL 07:35 UTC 2026-11-02, after push run 41399680083)
New-system = item_changelog `record-briefs` full_brief `item-briefs-%` since 2026-10-30; live = not archived (verified + quarantined).
- Regulations (domain 1): 94 new-system of 1361 live; 44 quarantined; 951 verified items still carry no what_is_it/why_matters/what_it_changes (the REG-BACKFILL backlog).
- Market (domain 4): 22 new-system of 53 live; 22 quarantined (pre-existing).
- Operations (domain 3): 23 new-system of 38 live; 10 quarantined (pre-existing); all 23 P58 items verified.
- Research (domain 7): 30 new-system of 49 live; 10 quarantined (pre-existing).
- Technology etc. (domain 2): 6 new-system of 15 live.
- Per bundle applied: IMMEDIATE-20 20/20; MARKET-20 20/20 (18 + 2 via MARKET-2); OPERATIONS-23 23/23 (18 + 5 via ops-refire-5); RESEARCH-30 30/30; REG-ACTION-12 12/12 (11 + 1 via reg-refire-1); REG-CRITICAL/HIGH-30 30/30; REG-DASH-2 2/2. Total P58 new-system entries applied: 137.
- PR 235 ruled run (push run 41399680083): research-30 (dea2bf82) 30 applied; ops-refire-5 (73ffcd9e) 5 applied; reg-dash-2 (eda002f8) 2 applied; reg-refire-1 (f2a6924e) 1 applied; migrate job applied 0151 at 06:24; visible job success. All nine re-fired items (053123bc, 282e480c, 71b03469, b4811af8, e5c17fac, c3fa4cc2, 51b2c91e, 67adbecd, 36203bb4) are verified with fresh section sets.
- Merges: PR 230 6291029db, PR 229 303fd8a73, PR 235 ff6d829ba; PR 236 LOCK-NO-BLOAT open and green (LIMITS src 67535 / core 20836 / brief 1335 / digest 270 / features 39924), merging.
- Live gate after the re-fire: 11 of 12 live checks pass (run 41407236336, 2026-11-02 07:45 UTC): member-reads, sign-in, pages, identity-anonymous, notification-drain, admin-pages, production-shape, applied-items-render, signed-in, no-404, no-raw-ids, rows-have-why PASS; no-fallback-summary FAIL on /regulations: 2 of 17 rows (Directive (EU) 2024/3101, Directive (EU) 2024/3099), the next two legacy Monitor-band items by due date. The Monitor band draws its five nearest-due rows and only three authored Monitor items carry a future date, so the gate stays red until REG-BACKFILL re-authors the nearest-due legacy Monitor items (batch 1 of 25 dispatched at close).

### Held and heal queues
- Held, no closed theme fits (THEME-VOCAB-1, operator ruling owed), research: ee8f4e71, 85a7a629, 97d22488, b88753be. Held, market: be729a3a (residue), 538c2774 (not a freight signal). Heal-queue items also held: ccee10a4, 67c6e313, b94cd283, fcf98c3d.
- Heal queue (pool < 2,000 chars): market 67c6e313, b94cd283; research fcf98c3d; regulation 35ab535c, 18eb5d1d, 6f240e0a, e8753abe, ccee10a4; framework 816b28ef, b90a8e25, f055f739.
- Quarantined by S-NUMERIC after apply: market 8c0049b4, ed63f522 (rewrites tested, follow-up bundle owed); operations 053123bc, 282e480c, 71b03469, b4811af8 (claim edits approved, re-fire in PR 235); FK failures e5c17fac (ops) and 51b2c91e (reg) re-fire after migration 0151.

### PR map
219 WAVE-P58 (LOC headroom, ruling 70); 220 RUNS-FIX-1; 221 ENTITY-MINT-1; 222 NORMALISE-2b; 223 LIST-RPC-1 (+0150); 224 STORED-DATE-1; 225 MARKET-20; 226 IMMEDIATE-20; 227 OPERATIONS-23; 228 RESEARCH-30; 229 DRY-MINT-1 (code, mirror of the mint gates in the dry; merged 303fd8a73); 230 RUNS-FIX-2 (+ ruled-runs queue step, parity baselines; green run 41396402099; merged 6291029db); 231 MARKET-2; 232 REG-ACTION-12; 233 refire-2 (merged 239199b5c); 234 REG-CRITICAL-HIGH-30; 235 FIX-1 (migration 0151 RECONCILE-FK-1 + ops-refire-5 + reg-refire-1 + reg-dash-2 + research-30 re-fire; green on ci/parity/schema; ruled run ok, push run 41399680083, merged ff6d829ba). Migrations: 0150 applied; 0151 lands through the CI migrate job (ADR-055).
- Live gate 41392850276 failed no-fallback-summary on /regulations (67adbecd, 36203bb4 legacy); REG-DASH-2 re-authored both, judged 20/20 (three passes). Last green live gate: 12/12 on run 41341590602 (before P58).
- Judge statistics: 441 first-pass fails across the wave, all revised and re-judged clean, 0 bundled failing.

### Refuted this wave
Antigravity's `list_workspace_items`; the 1c `cooldownMinutes`; the "dead row / cancelled CI run" reading (row 04a0da2b was a live, successful apply); "0 applied" in the MERGE-QUEUE-1 report; REG-SEV-1 "severity understated" (41 items; stored severity is snake_case); TEXT-CORRUPT-1 (display artifact; conditional section 3); CAPTURE-ANNEX-1 (pool holds Annex A-G); STORED-DATE-1 and RPC 0150 as causes of the parity failure (cause: CRITICAL band shrank from 20 to 2).

### Debts
DRY-MINT-1 (PR 229), MERGE-SERIAL-1, THEME-VOCAB-1, TITLE-POOL-1, JUR-FIX-1, SLOT-GAP-1, KIT-DATES-1, EXPORT-YEARS-1, GATE-A-CURRENCY-1, KIT-POINTERS-1, GATE-A-ASOF-1, DOCS-LEN-1, CHANGELOG-FIELDS-1, TIMELINE-MIRROR-1 [HYPOTHESIS], APPLY-SECTIONS-1 [HYPOTHESIS], the schema.sql S-NUMERIC comment (soft vs hard), POOL-DEDUP-1, DOCS-SEV-1, SKILL-TIER-1, RENDER-ENTITY-1 [HYPOTHESIS], OBL-DERIVE-2 (decision-ready), TEST-CLOCK-1, MINT-HOLD-1 follow-up bundle, ATOMIC-APPLY-1 (the apply writes full_brief before the section reconcile, so a reconcile failure leaves a new brief over legacy sections live; per-item apply must be one transaction or roll back), CI-STATUS-RUNS-1 (each main push fires 2-4 `status`-event CI runs, two fully skipped). CAPTURE-ANNEX-1 withdrawn.

### Backlog
- No-context legacy: 1065 regulations + 64 directives (monitoring) for REG-BACKFILL in 25-item batches. Corpus-wide: framework 45/256, initiative 403/441, guidance 28/82, market_signal 14/80, regional_data 4/35, research_finding 3/49.
- Next: fill the placeholders, live gate 12/12, LOC re-pin, REG-BACKFILL batches, PR 229 landed or pending.

## 9. OPERATOR-CLARITY-1 (2026-11-02): reader-first openings and the how-to rule

- **Producer contract (`src/core/brief/data/contract.json`, `full_brief`):** every section and numbered subsection opens with a plain-English guide and year-by-year bullets; a duty with no named portal, authority or deadline is a missing execution detail, closed by capturing the registry page into the pool or written as a GAP. Mirrored in `docs/authoring/item-briefs.md`. Contract version unchanged (pinned by `tests/intake/brief.test.ts`). Gates green: loc, ui-checks, connections, typecheck, lint.
- **EU PPWR 2025/40 (`efdb3390`):** all 15 sections now exist (9 and 13 added, conditional); each opens with a guide; Section 8 carries the 2026 to 2040 roadmap and a guide per subsection; Section 10 carries the 28-jurisdiction registration directory. 108 FACT claims untouched, `validate_item_provenance` valid, 0 orphans. `full_brief` was NOT regenerated (its Gate A hash would go stale); sections are what the page renders.
- **Registry portals:** 22 rows added to `sources` as `provisional`, paused, tiers proposed (needed for URL grounding, criterion 2). Pending source review.
- **Decision (EU) 2026/429 (`2f84502a`):** record to brief via the item-briefs batch (all rules and 20 judges passed); valid.
- **Debts:** the directory is operator research, not captured text; most rows are check level B (secondary source). Needs a capture lane to ground each portal page, and a second pass on the NOT FOUND cells (Sweden, Denmark, Poland, Estonia, Belgium, Italy).

### OPERATOR-CLARITY-1 follow-up (2026-11-02)
- **Four-surface rule** added to `contract.json` (`full_brief`) and `docs/authoring/item-briefs.md`: Regulations, Market Intel, Research and Operations each have a trigger and required dot-connecting; Operations is never reduced to labour or material prices. `tests/brief` 99/99 pass.
- **PPWR Section 10/3 second pass:** Sweden, Denmark, Poland, Estonia, Belgium (Valipac flagged for B2B transport packaging) and Italy rows updated. Sources added (provisional, paused): Sweden Naturvardsverket, Estonia TVO. Still unconfirmed on official pages: NPA/TMR and the FTI change (Sweden), Danish scheme status, Italian filing dates and RENTRI relevance, Belgian deadline, Estonian statutory date. `validate_item_provenance` valid, no failures.
- **/operations placeholder** now "port drayage ZEV mandates and grid queues, Rotterdam vs LA?".
- **D1 0/5 finding:** `regional_data_facts` holds zero `regulatory_feasibility` rows in every region (coverage rows honestly `missing`); `grid_intensity` has one UK row (NESO producer). No captured-source-backed rows exist to populate; needs a producer lane.

### OPERATOR-CLARITY-1 data lane (2026-11-02, live DB writes, no code)
- **/market "Why this matters":** `market_series` rows file under material entities (e.g. Fossil diesel and gas oil); a card shows a regulation only if an instrument entity relates to that material. Added `entity_relations` `implements` (asserted_by coupling/seed, cited quote): 2003/87 (EU ETS) to diesel and gasoline (ETS2 page quote); MARPOL to residual fuel oil (IMO Sulphur 2020 quote). Two provisional paused `sources` rows added. **Debt:** no item is filed under MARPOL, so the residual-fuel-oil link stays inert; FuelEU to fuel and heating gas oil/HFO series still unlinked.
- **Carbon cost per FEU, three missing inputs:** price = `eex-eua` producer `implemented:false`, no `data_sources` row (EEX licence uncleared), 0 series rows; payload = `feu-payload` has no producer or source; intensity = four GB ocean factors (container, bulk, general cargo, roro) so `selectFactor` by mode alone refuses to pick (INV-255). Needs: a licence-cleared EUA price source, a captured payload default, and a ruling on selecting `ocean_container_ship_average` for FEU corridors. Nothing invented.
- **/operations D5/D7:** `regional_data_facts` +3 EU infrastructure (DG MOVE quotes), +1 US infrastructure (EPA Clean Ports, $3bn), +1 US grid_intensity (Ember, 384 gCO2e/kWh, 2025, source_key ember). Coverage rows moved to populated by trigger. **Not done:** D1 rows (table comment says D1 renders via Regulations cross-refs; needs a ruling), EU/SG/UAE grid intensity (no figure retrievable from Ember/EEA pages), regional profile brief rebuilds.
