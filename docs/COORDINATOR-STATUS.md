# Coordinator Status & Handoff Report (`2026-10-30` late)

This file is the canonical handoff status for the coordinator session. Whenever the operator types `coordinator` or `/coordinator`, read this file first alongside `git log -n 10 --oneline` and `git status -s`.

---

## 1. Current Repository State

- **Branch:** `main` at `7ff2059f` (DRAIN-2F, PR 172). Its main push CI run (41152197719) concluded `success`; `ruled-runs` = success.
- **LOC Status (`node scripts/ci/loc.mjs`, run 2026-10-30 late):** `src` 66,268; `src/core` 20,421 (all 2026-10-30 PRs were 0 net src lines; `loc.mjs` LIMITS unchanged at src 66,291 / src/core 20,428, re-read on main).
- **Gates (`scripts/ci/gates.mjs`):** `workflow-yaml`, `lint`, `typecheck`, `build` (heavy), `test` (heavy), `validator-report`, `tree-checks`, `ui-checks`, `client-walk`, `loc`, `connections`, `columns`, `joinability`, `verify:citations`, `method-versions`, `migration-checks`, `edge-bundle` (scoped to the capture-worker), plus `schema:local` when `supabase/` changed.
- **Branch protection now enforces for admins:** every change goes via PR; `ci` + `schema` are required checks (`enforce_admins=true`, set via `gh api` 2026-10-30).
- **Pre-push hook runs the FULL profile** for src/tests/scripts/supabase/public/config changes (PR 167 HOOK-FULL-1, merged; ruling 43). Docs-only pushes run the fast profile.

---

## 2. What Changed Since `0a96e18` / `e79ed02` (2026-10-30 coordinator session)

`git log e79ed02..main`, 10 commits, all merged PRs (verified with `gh pr view`: 163-172 all MERGED):

- **MAIN-RED-1 (PR 165, `122ed0aa`):** two tests were red since the direct pushes. SectionIndex text restored, structure-test regex fixed, timeline test pins the stage label, parity baselines refreshed to the redesign (ruling 41), compare slot fix, mobile timeline date wrap.
- **SYNTH-APPLY-4 (PR 163, `efd1d788`):** two admin capital-radar answers on production: clusters `68275fe1d81735bb` (ex-3044) and `5d16d8d5fc4b3799` (ex-5dfc), gaps-and-signposts; 4 signposts + 5 gap flags written 22:07 UTC [not independently re-read].
- **CLASSIFY-FIX-1 (PR 164, `48c21340`):** `LEGISLATIVE_BODY_RE` accepts "HAVE ADOPTED" and `&nbsp;`; 5 EUR-Lex captures flip.
- **CI-TRIM-2 (PR 166, `bdc9b142`):** deployment-status browser checks run on production only; preview-parity removed (ruling 42).
- **HOOK-FULL-1 (PR 167, `8017ca0f`):** pre-push runs the full profile on code, test and CI changes (ruling 43).
- **PARITY-8 (PR 168, `f48d84f4`):** 17 unused approved-changes waivers deleted.
- **CLASSIFY-FIX-2 (PR 169, `c727284b`):** `detectNumeric` folds HTML spaces; EUR-Lex shell test host-gated, callers pass url; 96 Commission-domain captures stop being discarded.
- **DRAIN-2G (PR 170, `daf10c44`):** `947e08f3` IEA brief rewritten to the research contract, 21 FACT + 2 GAP [not independently re-read], verified 23:26 UTC. SELECT read: `provenance_status=verified`, severity `monitoring`, item_type `research_finding`.
- **DRAIN-2E (PR 171, `9305b394`):** `ff95b385` AFIR re-ground, 28 omitted events. SELECT read: `provenance_status=verified`, severity `monitoring`, item_type `regulation`.
- **DRAIN-2F (PR 172, `7ff2059f`):** `7a0ead55` FuelEU rewritten to the regulatory contract, 76 FACT [not independently re-read]. SELECT read: `provenance_status=verified`, severity `cost_alert`, priority `HIGH` (coordinator SELECT of the priority column, 00:51 UTC), item_type `regulation`.

Prior handoff content (editorial UI, auth waterfall removal, CI ratchet burn-down to zero, horizon-scan stage badges) stands; see `git log 2b813da..0a96e18`.

---

## 3. What Is Next

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
