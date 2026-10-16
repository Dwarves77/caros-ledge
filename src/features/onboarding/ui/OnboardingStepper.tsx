"use client";

// Ported from old_repo/src/components/onboarding/OnboardingStepper.tsx (lines 13-61)
import styles from "./onboarding.module.css";

const STEPS = [
  { n: 1, label: "Workspace" },
  { n: 2, label: "Modes & jurisdictions" },
  { n: 3, label: "Sectors" },
  { n: 4, label: "Briefing" },
] as const;

/** The four-pill progress row, shared by /workspace/new (step 1) and /onboarding (steps 2 to 4): done steps are checked, the current one is named by aria-current. Tokens only. */
export function OnboardingStepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol aria-label="Setup progress" className={styles.stepper}>
      {STEPS.map((s) => {
        const state = s.n < current ? "done" : s.n === current ? "active" : "todo";
        return (
          <li key={s.n} data-state={state} aria-current={state === "active" ? "step" : undefined} className={styles.step}>
            <span aria-hidden="true" className={styles.bullet}>
              {state === "done" ? "✓" : s.n}
            </span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}
