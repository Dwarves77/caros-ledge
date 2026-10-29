# Operator Rulings & Architecture Decision Records (2026-10-21)

Binding operator rulings and ADRs recorded 2026-10-21. These govern all lanes, stages, and surfaces alongside [WHY-2026-10-16.md](WHY-2026-10-16.md), [BUILD-PLAN-2026-10-12.md](BUILD-PLAN-2026-10-12.md), and [DESIGN-CHANGES-OWED.md](DESIGN-CHANGES-OWED.md).

## 1. Ruling — Typography & Look Governance

- Look changes (typography, font families, casing, layout, spacing, colour) belong exclusively to the operator and the artboards.
- No lane ships a look or typography change without the operator's explicit ruling first.
- No parity waivers (`tests/parity/approved-changes.json` or `scripts/ci/baseline-waivers.json`) or baseline recaptures (`tests/parity/baseline/`) may be added for unruled look changes; the red parity diff is the record until the operator rules.

## 2. Ruling / ADR — Synthesis Runs Inside the Turn (`Spec 08`), Verbatim Only

- Stage 8 (`briefs`) synthesis and Stage 6 (`connect`) theme synthesis run inside the turn (`run-turn.ts`), never as standalone scripts.
- Every sentence written into a section (`intelligence_item_sections`, `full_brief`, `theme_briefs`) must be a **verbatim grounded span** from the primary captured source pool (`isVerbatim` against `captured_text`) or an explicitly labelled `[Inference from grounded claim]` derived directly from a grounded claim.
- **Zero rule-generated connective prose:** Never emit template filler sentences, fabricated narrative transitions, or rule-generated interpretations. When a field or section has no grounded span in the captured source text, record a stated absence.

## 3. Ruling / ADR — A Target or Rulemaking Date Is Never an Operator Deadline

- A regulator's rulemaking mandate (`implementing_act_due`, `delegated_act_due`, `guidance_expected`—e.g. "By [date], the Commission shall adopt an implementing act...") is a **pending rulemaking trigger**, never an operator compliance deadline.
- Such dates must never populate `compliance_deadline`, urgency bands, or operator countdown timers.
- The detail page states only:
  1. What is known (from a verbatim span),
  2. What is pending (from a verbatim span),
  3. Which act it waits on, and
  4. When that act is due,
  each bound to a verbatim character span in the captured primary source.

## 4. Ruling — Prohibited Overbuilds (Never Build)

1. **No Rule-Generated Decision-Timing Opinions:** Never build rule-generated `"Act/Invest Today vs. Wait/Stage"` synthesis, horizon-bucketed capital-allocation advice (`0–12m`, `1–2y`, `2–5y` guidance strings), or decision-timing opinions (`ThemeForwardOutlook`, `AssessmentForwardOutlook`).
2. **No Mandatory Normative Fallback:** Never build a fallback that turns every modal verb (`shall`, `must`, `required`) into an obligation row without a concrete duty-holder or compliance object. Never lower the precision bar to inflate counts.
3. **No Hardcoded Physical or Financial Benchmarks:** Never introduce typed or hardcoded physical/financial constants (`6.5 mpg`, `0.10 MT/FEU`, hardcoded HVO spreads, etc.). Per `CARBON-1` and `INV-262`, every calculation uses a sourced, rated database row or renders an explicit stated absence.
4. **`FLY-2` Scope Restriction:** Discard `FLY-2` as a 5-module suite. Only the single mechanism of binding a regulation's own `Definitions` article (`'X' means Y`) to duty-holder classes may be tested as an isolated experiment, and it must be measured by before/after obligation classification yield on a read-only production copy before any merge decision.

## 5. Ruling — Process & Production Yield Gate

1. **Single-Worker Serialization:** One worker at a time. One PR and one CI run per slice. Run all local gates (`npm run gates`) before any push.
2. **Mandatory Production Yield (`before -> after`):** Every change to an extractor, classifier, or producer must report its production yield before and after (`before -> after`) against a read-only query of the production corpus. No yield number, no merge.
