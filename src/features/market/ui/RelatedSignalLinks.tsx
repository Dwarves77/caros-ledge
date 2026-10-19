// The Related section's signal links, as links.
import Link from "next/link";

import { deriveSeverity, SEVERITY_LABEL } from "../lib/signal-band";

import styles from "./market.module.css";

export function RelatedSignalLinks({ signals }: { signals: (Parameters<typeof deriveSeverity>[0] & { id: string; title: string })[] }) {
  return (
    <div className={styles.relatedList} data-audit="related-signals">
      {signals.map((x) => (
        <Link key={x.id} href={`/market/${encodeURIComponent(x.id)}`} prefetch={false} className={styles.relatedLink}>
          <span className={styles.relatedTitle}>{x.title}</span>
          <span className={styles.muted}>{SEVERITY_LABEL[deriveSeverity(x)]}</span>
        </Link>
      ))}
    </div>
  );
}
