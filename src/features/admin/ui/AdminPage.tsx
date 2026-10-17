// Ported from old_repo/src/app/admin/page.tsx (lines 188-238)
import { StateNote } from "@/ui";

import type { DashboardData } from "../read/dashboard";

import { AdminConsole } from "./AdminConsole";
import styles from "./admin.module.css";

/** The /admin page body: the console over the first-paint reads, or the one stated reason the admin reads cannot run here. */
export function AdminPage({ userId, userEmail, nowIso, initial, unavailable }: { userId: string; userEmail: string; nowIso: string; initial: DashboardData | null; unavailable?: string }) {
  if (!initial) {
    return (
      <div className={styles.single}>
        <StateNote tone="error">The admin console cannot read here: {unavailable ?? "its reads did not start"}.</StateNote>
      </div>
    );
  }
  return <AdminConsole userId={userId} userEmail={userEmail} nowIso={nowIso} initial={initial} />;
}
