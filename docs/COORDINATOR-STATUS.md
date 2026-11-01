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
