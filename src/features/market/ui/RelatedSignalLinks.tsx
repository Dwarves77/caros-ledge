// The Related section's signal links, as links.
import Link from "next/link";

import { severityLabel } from "../lib/severity";

import styles from "./market.module.css";

export function RelatedSignalLinks({ signals }: { signals: { id: string; title: string; severity?: string | undefined }[] }) {
  return (
    <div className={styles.relatedList} data-audit="related-signals">
      {signals.map((x) => (
        <Link key={x.id} href={`/market/${encodeURIComponent(x.id)}`} prefetch={false} className={styles.relatedLink}>
          <span className={styles.relatedTitle}>{x.title}</span>
          {severityLabel(x.severity) ? <span className={styles.muted}>{severityLabel(x.severity)}</span> : null}
        </Link>
      ))}
    </div>
  );
}
