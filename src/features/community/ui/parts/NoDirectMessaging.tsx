// Ported from old_repo/src/components/community/NoDirectMessagingNotice.tsx (lines 3-23)
// The no-direct-messaging statement (INV-226): shown wherever members are listed. Nothing in Community addresses one member privately.
import styles from "../community.module.css";

export function NoDirectMessaging() {
  return <p className={styles.note}>No direct messaging on Caro&rsquo;s Ledge. Peer contact happens in threads, in the open, never one-to-one.</p>;
}
