// Ported from old_repo/src/components/home/DashboardWatchlist.tsx (lines 65-127)
// Ported from old_repo/src/components/home/DashboardRailCard.tsx (lines 19-48)
import Link from "next/link";

import { formatNumber } from "@/core/shared";
import { RailCard, RelativeTime, StateNote } from "@/ui";
import { WATCHLIST_TYPE_LABEL } from "@/features/watchlist/links";
import type { WatchlistItem } from "@/features/watchlist/read/watchlist";

import styles from "./dashboard.module.css";

const SHOWN = 3;

function Entry({ item }: { item: WatchlistItem }) {
  const href = item.fields?.href;
  const body = (
    <>
      <p className={styles.watchKicker}>
        {item.fields?.jurisdiction ?? WATCHLIST_TYPE_LABEL[item.type].toUpperCase()}
        {item.scope === "team" ? <span className={styles.team} title="On the workspace watchlist: every member sees this">Team</span> : null}
      </p>
      <p className={styles.watchTitle}>{item.title}</p>
      <p className={styles.watchMeta}>
        <RelativeTime iso={item.watchedAt} /> · {WATCHLIST_TYPE_LABEL[item.type]}
        {item.scope === "team" && item.addedBy ? ` · added by ${item.addedBy}` : ""}
      </p>
      {item.scope === "team" && item.note ? <p className={styles.watchMeta}>{item.note}</p> : null}
    </>
  );
  return <li>{href ? <Link href={href} prefetch={false} className={styles.watchItem}>{body}</Link> : <div className={styles.watchItem}>{body}</div>}</li>;
}

/** The rail's Watchlist card: the three most recent watches (personal and team) and a way to the full list; null items means the read failed, said with Retry. */
export function WatchlistRailCard({ items, onRetry }: { items: WatchlistItem[] | null; onRetry: () => void }) {
  if (items === null) {
    return (
      <RailCard title="Watchlist" titleHref="/watchlist" dataAudit="watchlist-rail">
        <StateNote tone="error" action={{ label: "Retry", onClick: onRetry }}>
          Your watchlist did not load.
        </StateNote>
      </RailCard>
    );
  }
  if (items.length === 0) {
    return (
      <RailCard title="Watchlist" titleHref="/watchlist" dataAudit="watchlist-rail">
        <StateNote action={{ label: "Browse what to watch →", href: "/regulations" }}>Nothing watched yet. Watch any regulation, source, or market signal to see its updates here.</StateNote>
      </RailCard>
    );
  }
  return (
    <RailCard title="Watchlist" titleHref="/watchlist" dataAudit="watchlist-rail" titleCount={`${formatNumber(Math.min(SHOWN, items.length))} of ${formatNumber(items.length)}`}>
      <ul className={styles.watchList}>
        {items.slice(0, SHOWN).map((item) => (
          <Entry key={`${item.scope}:${item.type}:${item.id}`} item={item} />
        ))}
      </ul>
    </RailCard>
  );
}
