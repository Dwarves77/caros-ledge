// Ported from old_repo/src/components/detail/SourcesGrid.tsx (lines 1-161)
import type { SourceRow } from "@/core/detail/sources-parse";
import { hasBiasTags } from "@/core/sources/bias-tags";

import { Absence } from "../Absence";
import { BiasChips } from "../BiasChips";
import { TierChip } from "../Chips";

/** The Sources section's rows: the registry's rating on each (a dash with its reason when the registry has none), the source name as the link, its bias tags outside the link (a control never nests in an anchor). */
export function SourcesGrid({ rows }: { rows: SourceRow[] }) {
  return (
    <div>
      {rows.map((s, i) => {
        const inner = (
          <>
            {typeof s.tier === "number" ? <TierChip tier={s.tier} /> : <span style={{ width: 24, display: "inline-flex", justifyContent: "center" }}><Absence reason="not in primary source" variant="dash" /></span>}
            <div style={{ minWidth: 0 }}>
              <p className="cl-source-name">{s.name}</p>
              {s.meta && <p className="cl-source-meta">{s.meta}</p>}
            </div>
          </>
        );
        return (
          <div key={i} data-part="source-row" className="cl-source-row">
            {s.url ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="cl-src-link">
                {inner}
              </a>
            ) : (
              <div className="cl-src-link">{inner}</div>
            )}
            {hasBiasTags(s.biasTags) && (
              <div className="cl-source-bias">
                <BiasChips tags={s.biasTags} variant="detail" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
