# Coordinator Status & Handoff Report (`2026-10-30`)

This file is the canonical handoff status for the coordinator session. Whenever the operator types `coordinator` or `/coordinator`, read this file first alongside `git log -n 10 --oneline` and `git status -s`.

---

## 1. Current Repository State

- **Branch:** `main` (clean working tree, synced with `origin/main`)
- **LOC Status (`scripts/ci/loc.mjs`):**
  - `src`: `66,268` / `66,291` ceiling (`23` lines of headroom)
  - `src/core`: `20,421` / `20,428` ceiling (`7` lines of headroom)
- **Fast CI Gates (`node scripts/ci/gates.mjs --profile fast`):** All 13 gates pass (`workflow-yaml`, `lint`, `typecheck`, `validator-report`, `tree-checks`, `ui-checks`, `loc`, `connections`, `columns`, `joinability`, `verify:citations`, `method-versions`, `migration-checks`).

---

## 2. What Changed Since the Previous Coordinator Handoff (`2b813da` -> `0a96e18`)

### A. Editorial UI, Dossier Hierarchy & Layout Density (`970d2be`, `bd23272`, `2bd5b75`, `8d3b53a`, `4de0a9f`, `7bb8504`, `dfa33d1`)
1. **Dossier Navigation & Statutory Breakdown Directory:**
   - Restored display typography and compacted masthead, `src/ui/ActionCard.tsx`, and `src/ui/Timeline.tsx` vertical footprint.
   - Added the `Full Statutory Breakdown Directory` in `src/features/regulations/RegulationDetail.tsx` when viewing in Summary mode, and moved `src/features/regulations/ObligationRegister.tsx` to a closed-by-default expandable disclosure at the foot of the regulation detail page with keyword and event-type filtering.
2. **Eliminated Exposure Grid Dead Space (`dfa33d1`):**
   - Moved the `Show more` / `Show less` toggle inline into `.cl-exposure-head` in `src/ui/ActionCard.tsx` and rebalanced `.cl-exposure-grid` column tracks (`minmax(100px, 0.75fr) minmax(170px, 1.35fr) minmax(90px, 0.55fr) minmax(220px, 1.75fr)`) in `src/ui/base.css`.
3. **6-Color Semantic Section Headers & Permanent Explainer Bars (`8d3b53a`, `4de0a9f`, `7bb8504`):**
   - Applied semantic section themes and permanent explainer headers across Regulations (`src/features/regulations/pages.tsx`, `src/features/regulations/RegulationDetail.tsx`), Market Intel (`src/features/market/ui/Spec09Panels.tsx`, `src/features/market/ui/MarketDetailView.tsx`), Operations (`src/features/operations/ui/RegionMatrix.tsx`, `src/features/operations/ui/OperationsDetail.tsx`), Research (`src/features/research/ui/ResearchDetail.tsx`, `src/features/research/ui/AssessmentRail.tsx`), and Dashboard (`src/features/dashboard/ui/DashboardBrief.tsx`).

### B. Sub-Second Page Navigation & Auth/Database Waterfall Elimination (`2c69eef`, `ca023f6`, `84824a7`, `dfa33d1`)
1. **Zero Network Round-Trips on Warm Auth Reads (`src/core/auth/claims.ts`, `src/proxy.ts`):**
   - Decoded verified session user claims directly from `getSession()` in `src/core/auth/claims.ts` with an LRU warm cache before falling back to GoTrue network calls.
   - Excluded `/api` routes from `src/proxy.ts` matcher and avoided redundant cross-region `getUser()` calls in `src/proxy.ts`.
2. **Eliminated Client Startup & Prefetch Floods (`src/ui/shell/bootstrap-store.ts`, `src/ui/shell/TopBar.tsx`, `src/ui/shell/AppShell.tsx`):**
   - Consolidated shell bootstrap fetches into `src/ui/shell/bootstrap-store.ts`, gated on authenticated identity.
   - Added instant hover/pointer-down route prefetching in `src/ui/shell/TopBar.tsx`, `src/ui/shell/NavCard.tsx`, and list row links (`src/ui/ListRow.tsx`).
3. **Flattened Server-Component Query Waterfalls (`src/features/regulations/pages.tsx`, `src/features/lists/read.ts`, `src/core/impact/attach.ts`, `src/core/detail/load.ts`):**
   - Parallelized profile, theme chip, denominator coverage, list page, and impact score reads with `Promise.all` across all primary list and detail routes.

### C. Complete CI Ratchet Debt Burn-Down (`c750976`, `aeb5022`, `4b5bc54`, `da20332`, `e7d35b0`)
1. **`INV-263` Silent-Read Findings (`c750976`):**
   - Closed all 5 remaining silent-read findings across surface loaders so every failed read surfaces an explicit degraded/failure banner with Retry.
2. **`scripts/ci/connections-allow.json` (`aeb5022`, `4b5bc54`):**
   - **100% emptied (`0` entries)** across `"files"`, `"exports"`, `"deps"`, and `"runtimeEntries"`.
3. **Static Joinability (`scripts/ci/data/joinability.json`, `aeb5022`):**
   - Closed all 16 `J1:*` unmapped columns and `J3sevw:accepts` (`0` static joinability findings across `J1`, `J2`, `J3const`, `J3sevw`).
4. **`tests/derived/customer-strings.json` (`aeb5022`):**
   - Cleared `"owed": []` (`0` owed customer-visible string violations).
5. **`scripts/ci/ui-checks-allow.json` (`aeb5022`, `4b5bc54`, `da20332`, `e7d35b0`):**
   - **100% eliminated all 9 actionable UI debt categories:**
     - `style-on-kit-part` (`0` remaining)
     - `supabase-error-unhandled` (`0` remaining)
     - `style-px` (`0` remaining across 13 files / 54 offences)
     - `raw-form-control` (`0` remaining across 11 files / 17 offences; added `bare?: boolean` to `Input` and `Textarea` in `src/ui/FormField.tsx`)
     - `http-error-message` (`0` remaining across 6 files)
     - `css-px-scale` (`0` remaining across 18 CSS files / 826 offences; migrated to `--sp-*`, `--fs-*`, `--target`, and `rem`)
     - `kit-fetch` (`0` remaining across 5 files / 14 offences)
     - `wall-clock` (`0` remaining across 43 files / 61 offences; replaced with `performance.timeOrigin + performance.now()`)
     - `kit-imports-feature` (`0` remaining across 6 files in `src/ui/shell/`; hosted `AuthContext` in `src/ui/shell/Providers.tsx` and inverted item-state hydration via `registerItemStateHydrator` in `src/ui/shell/bootstrap-store.ts`)
   - Only the 4 permanent architectural declarations (`colour-built-at-runtime` ruling B, `class-undefined` non-CSS storage/id prefixes, `bare-fetch` low-level transport primitives, and `entity-in-string` Leaflet HTML attribution) remain in `scripts/ci/ui-checks-allow.json`.

### D. Horizon Scan Stage Classification & Explicit Applicability Assumptions (`0a96e18`)
1. **Statutory Stage Badges on Timeline Milestones (`src/ui/timeline-math.ts`, `src/ui/Timeline.tsx`):**
   - Added `milestoneStageOf` in `src/ui/timeline-math.ts` to classify milestones into `Proposed / consultation`, `Entry into force`, `Rulemaking due`, `Phase-in`, `Review / report`, or `Enacted deadline` from `event_kind` or verbatim milestone clauses, and rendered the badge on track markers, expanded schedule rows, and the context drawer in `src/ui/Timeline.tsx`.
2. **Explicit Applicability Assumptions (`src/core/detail/item-read.ts`, `src/ui/detail/action-card-props.ts`, `src/ui/detail/ItemConnections.tsx`, `src/features/regulations/RegulationDetail.tsx`):**
   - Wired `operationalScenarioTags` and resolved `ItemRelevance` (`Matched: ... · In scope: ... · Scenarios: ...`) into `commonActionCardProps` (`Your lanes`) and surfaced `In scope because:` triggers and applicability reasons inside `RelevanceRailCard`.

---

## 3. What Is Next (Prioritized Backlog for Coordinator / Claude Code)

1. **Admissible-Row Predicate in Community Post Route (`tests/derived/readers.json`):**
   - `tests/derived/readers.json` has only **1 remaining `"owed"` entry** in the entire repository: `src/features/community/api/post.ts` (owned by `R2e`), which reads `intelligence_items` without `admitItems` (`src/core/derived/admissible.ts`). Routing that lookup through `admitItems` and removing the entry from `tests/derived/readers.json` will bring `tests/derived/readers.json` `"owed"` to `0`.
2. **Database-Level Joinability Ratchet (`scripts/ci/joinability-allow.json`):**
   - Static joinability (`J1`, `J2`, `J3const`, `J3sevw`) is at `0` findings.
   - Schema/live-row joinability (`scripts/ci/joinability-allow.json`, verified via `npm run joinability:schema`) has 19 tracked entries across:
     - `J3toknovocab` (`oem_tech_roadmaps.commercial_stage`, `research_assessments_current.horizon_band`, `research_assessments_current.horizon_kind`) and `J3tok` (`oem_tech_roadmaps.tech_category`)
     - `J3unit` (`state_cost_facts.unit` `/hr` form)
     - `J3sev` (`intelligence_items.severity` migration slice `SEV-1`)
     - `J5` producer population slices (`derived_values.entity_id`, `market_series.entity_id`, `obligation_objects.first_deadline`, `obligation_objects.instrument_entity_id`, `obligation_objects.source_id`, `obligation_objects.statutory_maximum`, `oem_tech_roadmaps.target_year`, `regional_data_facts.as_at_date`, `regional_data_facts.source_id`, `regional_data_facts.unit`, `regional_data_facts.value_numeric`, `research_assessments_current.entity_id`, `research_assessments_current.technical_maturity_low`, `section_claim_provenance.source_id`, `section_claim_provenance.source_tier_at_grounding`).
3. **Judgement Drain & Brief Authoring Batches (`.claude/commands/drain.md`):**
   - Continue executing scheduled judgement drain batches (`item-briefs`, `theme-briefs`, `admin-opportunity-findings`, `ledger-verdicts`) via `/drain` when the drain switch is enabled.
4. **Full CI Profile & Parity Baseline Verification (`node scripts/ci/gates.mjs --profile full`):**
   - Run the full gate profile (`build`, `test`, `client-walk`, and `schema:local` when `supabase/` changes) to keep production parity green.
