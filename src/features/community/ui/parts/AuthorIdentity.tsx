// Ported from old_repo/src/components/community/AuthorIdentityChip.tsx (lines 9-54)
// Ported from old_repo/src/components/community/VerifierBadge.tsx (lines 12-38)
// Ported from old_repo/src/components/community/Post.tsx (lines 194-221)
// The author line of a post, reply or search hit (INV-224): name and company shown by default, then org type, role, sector and region; an anonymous author reads "Anonymous member" with a neutral avatar and the
// verified mark KEPT; nothing in it is derived from the id. One verified mark for both the account check and the line (the old tree drew it twice).
import { authorIdentityLabel } from "../../lib/identity-format";
import type { AuthorBlock } from "../../lib/types";
import styles from "../community.module.css";

import { Avatar } from "./Avatar";

export function VerifiedMark() {
  return (
    <span className={`${styles.chip} ${styles.chipVerified}`} title="Verified member: a company email address on the account">
      Verified
    </span>
  );
}

/** The sign-off mark: a verifier checked the post's claim against a primary document. It is NOT the member's "Verified" mark (a company email on the account): the two were one word and one component. */
export function SignedOffMark() {
  return (
    <span className={`${styles.chip} ${styles.chipSignedOff}`} title="A verifier signed this off against a primary document">
      Signed off
    </span>
  );
}

export function AuthorIdentity({ author, size = 36, withAvatar = true }: { author: AuthorBlock | null | undefined; size?: number; withAvatar?: boolean }) {
  if (!author) {
    return (
      <span className={styles.authorLine}>
        {withAvatar && <Avatar neutral size={size} />}
        <span className={styles.authorText}>Former member</span>
      </span>
    );
  }
  const line = authorIdentityLabel(author);
  return (
    <span className={styles.authorLine}>
      {withAvatar && <Avatar name={author.name} url={author.headshotUrl} size={size} neutral={author.anonymous} />}
      <span className={styles.authorText}>
        <span className={styles.authorName}>{line ?? "Member"}</span>
        {author.verified && <VerifiedMark />}
      </span>
    </span>
  );
}
