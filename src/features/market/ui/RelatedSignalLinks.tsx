// The Related section's signal links. Links, not list items: the old page drew them as bare links, and an `li` here is a row the parity gate samples (first 20 `li, tr, article`), which pushes the theme brief's bullets out of the window.
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
