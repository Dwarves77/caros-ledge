// Ported from old_repo/src/components/ui/ImpactMeter.tsx (lines 114-301)
import type { ImpactScores } from "@/core/types";

import { Absence } from "./Absence";
import { isImpactScored, rampColor, segmentFilled, SEGMENT_GROUPS, sumScores } from "./impact";

function Segments({ n }: { n: number }) {
  const color = rampColor(n);
  return (
    <span className="cl-impact-bars">
      {SEGMENT_GROUPS.map((group, g) => (
        <span key={g} aria-hidden="true" className="cl-impact-group">
          {group.map((i) => (
            <span key={i} aria-hidden="true" className="cl-impact-bar" style={{ background: segmentFilled(n, i) ? color : "var(--cl-impact-track)" }} />
          ))}
        </span>
      ))}
    </span>
  );
}

interface ImpactMeterProps {
  scores?: ImpactScores | null | undefined;
  /** The sentence naming the input the score is waiting for; the dash is named by it when there is one. */
  absence?: string | null | undefined;
  total?: number | undefined;
  variant?: "row" | "full";
  valueVisible?: boolean;
}

/** Twelve segments in four groups of three, one ramp colour at N; unscored draws ONE quiet dash (the cell stays, no outlines, never the word "unscored"). `full` is the per-dimension meter. */
export function ImpactMeter({ scores, absence, total, variant = "row", valueVisible = false }: ImpactMeterProps) {
  if (variant === "full") return <FullVariant scores={scores} />;
  if (total == null && !isImpactScored(scores)) {
    return (
      <span className="cl-impact-unscored">
        <Absence reason="unscored" variant="dash" label={absence ?? "Impact not scored"} text={absence} />
      </span>
    );
  }
  const n = total ?? sumScores(scores as ImpactScores);
  return (
    <span className="cl-impact-scored" aria-label={`Impact ${n} of 12`}>
      <Segments n={n} />
      {valueVisible && (
        <span className="cl-impact-value">
          <b>{n}</b>
          <span>/12</span>
        </span>
      )}
    </span>
  );
}

const VALUE_COLOR: Record<number, string> = { 1: "var(--awareness)", 2: "var(--action)", 3: "var(--immediate)" };

function FullVariant({ scores }: { scores?: ImpactScores | null | undefined }) {
  if (!isImpactScored(scores)) {
    return (
      <span aria-label="Impact not scored" title="Impact not scored" className="cl-impact-full-unscored">
        <span aria-hidden="true" className="cl-impact-full-dash" />
        <Absence reason="unscored" variant="dash" />
      </span>
    );
  }
  const rows: Array<[string, number]> = [
    ["Cost", scores.cost],
    ["Compliance", scores.compliance],
    ["Client-facing", scores.client],
    ["Operational", scores.operational],
  ];
  return (
    <div className="cl-impact-full">
      {rows.map(([label, v]) => (
        <div key={label} className="cl-impact-full-row">
          <span className="cl-impact-full-label">{label}</span>
          <span className="cl-impact-full-track">
            <span aria-hidden="true" className="cl-impact-full-cover" style={{ left: `${(v / 3) * 100}%` }} />
          </span>
          <span className="cl-impact-full-value" style={{ color: VALUE_COLOR[v] ?? "var(--ink-3)" }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}
