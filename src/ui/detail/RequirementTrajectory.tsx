// Ported from old_repo/src/components/detail/RequirementTrajectory.tsx (lines 1-37)
import { formatTrajectoryStep, pickCurrentStepIndex, type TrajectoryStep } from "@/core/detail/timeline";

/** The requirement path as one line, the step that applies at `nowIso` in bold. Renders nothing for a missing or empty trajectory. */
export function RequirementTrajectory({ trajectory, nowIso }: { trajectory: { steps: TrajectoryStep[]; note?: string } | null | undefined; nowIso: string }) {
  if (!trajectory || !Array.isArray(trajectory.steps) || trajectory.steps.length === 0) return null;
  const current = pickCurrentStepIndex(trajectory.steps, nowIso);
  return (
    <>
      {trajectory.steps.map((step, i) => (
        <span key={i}>
          {i > 0 ? " → " : ""}
          {i === current ? <strong>{formatTrajectoryStep(step)}</strong> : formatTrajectoryStep(step)}
        </span>
      ))}
      {trajectory.note ? `; ${trajectory.note}` : ""}
    </>
  );
}
