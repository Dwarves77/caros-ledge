// Ported from old_repo/src/components/community/RoleBadge.tsx (lines 6-38)
// Ported from old_repo/src/components/community/GroupHeader.tsx (lines 402-431)
// Ported from old_repo/src/components/community/GroupModals.tsx (lines 416-452)
// The one role chip (three looks for one role): Admin and Moderator are drawn; a plain member has no chip.
import type { GroupRole } from "../../lib/types";
import styles from "../community.module.css";

export function RoleChip({ role }: { role: GroupRole | null | undefined }) {
  if (role !== "admin" && role !== "moderator") return null;
  const admin = role === "admin";
  return (
    <span className={`${styles.chip} ${admin ? styles.chipStrong : ""}`} title={admin ? "Group admin" : "Group moderator"}>
      {admin ? "Admin" : "Moderator"}
    </span>
  );
}
