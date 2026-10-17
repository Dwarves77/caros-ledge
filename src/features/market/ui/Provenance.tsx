// Ported from old_repo/src/components/market/SeriesProvenance.tsx (lines 30-170)
// The methodology and provenance drawer (spec 02 row 10): one click from any number, closed by default. It draws the fields the figure has (lib/provenance) and ALWAYS the rating of the source (INV-262); a source ref links to the source
// when it has a url.
import { provenanceRows, type FigureEnvelope } from "../lib/provenance";

import styles from "./market.module.css";

/** The fields grid. */
export function ProvenanceFields({ envelope }: { envelope: FigureEnvelope }) {
  return (
    <dl data-audit="series-provenance-fields" className={styles.provGrid}>
      {provenanceRows(envelope).map((r) => (
        <div key={r.label} className={styles.provRow}>
          <dt>{r.label}</dt>
          <dd>
            {r.href ? (
              <a href={r.href} target="_blank" rel="noopener noreferrer" className={styles.provLink}>
                {r.value}
              </a>
            ) : (
              r.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ProvenanceDrawer({ envelope }: { envelope: FigureEnvelope }) {
  return (
    <details className={styles.drawer}>
      <summary className={styles.drawerSummary}>Methodology &amp; provenance</summary>
      <ProvenanceFields envelope={envelope} />
    </details>
  );
}
