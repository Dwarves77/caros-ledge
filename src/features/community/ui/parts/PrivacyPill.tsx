// Ported from old_repo/src/components/community/GroupCard.tsx (lines 343-408)
// Ported from old_repo/src/components/community/GroupHeader.tsx (lines 355-400)
// The one privacy pill (two sizes for one pill): Public, or Private and by invitation.
import type { Privacy } from "../../lib/types";
import styles from "../community.module.css";

export function PrivacyPill({ privacy }: { privacy: Privacy }) {
  return <span className={`${styles.chip} ${privacy === "private" ? styles.chipPrivate : styles.chipPublic}`}>{privacy === "private" ? "Private · By invitation" : "Public"}</span>;
}
