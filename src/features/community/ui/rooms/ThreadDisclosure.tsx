"use client";

// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 638-763)
// What opens under a discussion row: the text, the live system items it cites (system to Community links only: a link into the ledger, nothing flows back), the sign-off state, a reply box and the cite panel. Closed until
// the row is opened. The reply goes through the reply route (the same composer as the group feed); citing goes through the cite route under the caller's row policy, not a table write from the browser.
import Link from "next/link";

import { Button } from "@/ui";

import type { LiveItem, ThreadVM } from "../../lib/rooms-view";
import styles from "../community.module.css";
import { AuthorIdentity } from "../parts/AuthorIdentity";
import { ReplyComposer } from "../posts/ReplyComposer";

export type DisclosureMode = "read" | "reply" | "cite";

export function ThreadDisclosure({ thread, liveItems, mode, busy, onReplied, onCite }: { thread: ThreadVM; liveItems: LiveItem[]; mode: DisclosureMode; busy: boolean; onReplied: () => void; onCite: (item: LiveItem) => void }) {
  const cited = liveItems.filter((l) => l.uuid && thread.referencedItemIds.includes(l.uuid));
  const others = thread.referencedItemIds.length - cited.length;
  return (
    <div className={styles.disclosure}>
      <AuthorIdentity author={thread.author} size={28} />
      {thread.body && <p className={styles.body}>{thread.body}</p>}
      {cited.length > 0 && (
        <div className={styles.chipRow}>
          {cited.map((c) => (
            <Link key={c.id} href={c.href} className={styles.chip}>
              Cited: {c.title.slice(0, 40)}
            </Link>
          ))}
        </div>
      )}
      {others > 0 && (
        <p className={styles.muted}>
          {others} cited source{others > 1 ? "s" : ""} outside this room&rsquo;s live items
        </p>
      )}
      {thread.signoff?.status === "pending" && (
        <p className={styles.strong}>
          Sign-off requested{thread.signoff.isMine ? "" : ` · ${thread.signoff.requesterName}`}. A verifier has not decided yet.
        </p>
      )}
      {thread.signoff?.status === "declined" && <p className={styles.strong}>Sign-off declined</p>}
      {mode === "reply" && <ReplyComposer postId={thread.id} onReplied={onReplied} />}
      {mode === "cite" && (
        <div className={styles.citePanel}>
          <p className={styles.eyebrow}>Cite a live item in this region</p>
          {liveItems.length === 0 && <p className={styles.muted}>No live items in this region to cite.</p>}
          {liveItems.map((li) => {
            const already = !!li.uuid && thread.referencedItemIds.includes(li.uuid);
            return (
              <Button key={li.id} variant="ghost" onClick={() => onCite(li)} disabled={busy || already || !li.uuid}>
                {already ? "Attached" : "Cite"} · {li.title}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
