# Coordinator Status & Handoff Report (`2026-10-31` close of the customer-context wave)

This file is the canonical handoff status for the coordinator session. Whenever the operator types `coordinator` or `/coordinator`, read this file first alongside `git log -n 10 --oneline` and `git status -s`.

---

## 1. Current Repository State

- **Branch:** `main` at `55991423` (PR 196 UI-RADAR-3) at the time of writing, plus later docs/lock PRs; verify with `git log -n 10`.
- **Branch protection:** `enforce_admins=true`; every change via PR; `ci` + `schema` required.
- **Local gates:** pre-push runs the fast profile plus tests mapped from changed modules, once; the passing HEAD is remembered in the git-dir (ruling 55, PR 180). The full matrix runs in GitHub Actions only.
- **Scrape cadence:** `off` (build mode, rule 16). Migrations 0145-0148 applied.

## 2. Merged since 2026-10-30 (PRs 176-197, all MERGED)

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

## 3. Production facts (coordinator reads, 2026-10-31)

- Production theme_briefs 12/5/3/0 (per THEME-1b closing state).
- Patterns grouped and named; pairwise reasons; developing empty state; what-moves block; Oil Bulletin rows with why text.
- Orphan clean-up (1,272 entity_refs on deleted events, 600 refs on 67 deleted obligation_objects, 67 orphan obligation entities) staged at `C:/tmp/fa1-scratch/ets-clean-2.sql`, NOT run (harness refuses agent deletions). Read-only count: entity_refs 52,062, entities 5,540, unchanged.

## 4. Live gate assertions

- Armed (signed in): no-404, ribbon-complete, rows-have-why, connections-have-reason, radar-present, no-raw-ids.
- Unarmed: no-pending-text, own-mandates, scoped-grid, reasons-are-pairwise.

## 5. Follow-ups queued

- DRAIN-THEMES-1: drain-authored theme briefs on membership change (ADR-050), when cadence returns.
- REG-BACKFILL-1: 985 regulations with blank what/why/changes, produced by the turn.
- PRODUCER-CAPTURE-1: Oil Bulletin producer files each week as a capture so prose can quote values.
- Arm own-mandates, scoped-grid, no-pending-text after a production pass; reasons-are-pairwise once shared_obligation evidence appears.
- Orphan refs clean-up (operator-run); remove the 0146 migration_log orphan row.
- Typecheck "cached" skip under the gates memo (trace).
- LOCK-NO-BLOAT-2 re-pin (in flight).
- Items below under "Carried backlog" still stand.

## 6. Standing rules learned 2026-10-31

- Local gates are fast; the full matrix runs in CI only (ruling 55).
- Watch every PR to green and merged; a parked PR is a miss.
- An independent judge reads every authored brief; self-judging is not evidence (ruling 60).
- Rule 3: schema DDL applies via CLI before the dependent code commits; migration numbers are allocated in landing order (ruling 62).
- One vault PR at wave close.
- No content merge between a theme-brief push and its run (ruling 61).

---

## 7. Carried backlog (from 2026-10-30)

### Carried from the prior backlog
1. **Community post route admissible-row predicate:** `tests/derived/readers.json` has 1 `owed` entry, `src/features/community/api/post.ts` (reads `intelligence_items` without `admitItems`, `src/core/derived/admissible.ts`). Route it through `admitItems`, remove the entry.
2. **Schema joinability:** `scripts/ci/joinability-allow.json` holds 19 entries (`npm run joinability:schema`): J3toknovocab/J3tok (oem_tech_roadmaps, research_assessments_current), J3unit (state_cost_facts.unit), J3sev (intelligence_items.severity, SEV-1), J5 producer population slices.
3. **Judgement drain batches** via `/drain` (`item-briefs`, `theme-briefs`, `admin-opportunity-findings`, `ledger-verdicts`) when the drain switch is on.
4. **Full profile verification:** `node scripts/ci/gates.mjs --profile full`.

### Content owed
- Visibility check on carosledge.com of the released items: research list shows `947e08f3`; regulations show `ff95b385` and `7a0ead55`.
- Derive the obligation objects now their instruments are verified: 8 for `ff95b385`, 17 for `7a0ead55`.
- Re-source `947e08f3`'s IEA figures when the scrape cadence returns (source `ab2c35c3`; stored captures are a Cloudflare page and a stub).
- `15f63ea9` R33 versus growing supplied dates (design question).

### Code window (after content runs; one home per mechanism, cite the owner)
1. Obligation derive reads the item before the briefs apply flips it to verified, refusing `instrument_item_missing` for a quarantined-but-present instrument; the refusal label is also untruthful. Owner: `src/features/obligations/derive/derive-objects.ts` `deriveObligationObjects` + `buildObjectRow`.
2. A stored wall-page capture over 200 chars counts as a usable capture and is never refetched. Owner: `src/features/mint/heal/run.ts` step 1 and `source.ts` `capturePage`.
3. Gate A flags dates stated from DB source records (e.g. `sources.last_inaccessible`) as orphans because no capture span carries them, forcing year-less wording.
4. `themeOf()` keyword fallback (`src/features/research/model/taxonomy.ts`) is a word list (ADR-053/054).
5. `validate_item_provenance` criterion 5 word-matches `slot_key` in `claim_text`: replace with a typed `slot_key`.
6. No transition log for `provenance_status` flips.
7. NORMALISE-2: `jurisdiction_iso`, corridor, `value_numeric`, result, TRL in the reader contract.
8. Derive files obligations under all 5 modes; `technologyEntityOf` null; velocity / crossModal / penaltyAbatement detectors at 0.

### Rules in force (vault rulings 41-43 and the repo CLAUDE.md)
- The redesign is the look and baselines follow it.
- A lane pushes once after the full profile is green locally.
- Content runs touch no src; repair, not reject.
- One home per mechanism; no word lists.
- Root cause, never re-run.
