// Ported from old_repo/src/components/community/CouncilMembersRail.tsx (lines 22-201)
// The group page's members rail: up to six members, leaders first, "+ N more", and the no-direct-messaging statement. The page reads the roster and hands it in; a failed read is a stated failure with Retry (the old
// rail drew the private-group sentence for a read error, telling a member the group was private when the database was unreachable), and a plain member sees themself and the count of the others.
import { RailCard } from "@/ui";

import type { RosterEntry } from "../lib/roster";
import type { GroupRole } from "../lib/types";

import styles from "./community.module.css";
import { Avatar } from "./parts/Avatar";
import { NoDirectMessaging } from "./parts/NoDirectMessaging";
import { RoleChip } from "./parts/RoleChip";
import { RailRetry } from "./RailRetry";

const SHOWN = 6;

export function MembersRail({ members, total, namesFailed = false }: { members: RosterEntry[] | null; total: number; namesFailed?: boolean }) {
  return (
    <RailCard title="Members" headRight={<span className="cl-rail-count">{total}</span>}>
      <div className={styles.railPad}>
        {members === null ? (
          <RailRetry>The members could not be loaded.</RailRetry>
        ) : (
          <>
            {namesFailed && <RailRetry>The members&rsquo; names could not be loaded.</RailRetry>}
            <ul className={styles.plain}>
              {members.slice(0, SHOWN).map((m, i) => (
                <li key={`${m.joined_at}-${i}`} className={styles.personRow}>
                  <Avatar name={m.name} url={m.headshot_url} size={28} neutral={m.anonymous} />
                  <span className={styles.grow}>
                    {m.anonymous && !namesFailed ? "Anonymous member" : (m.name ?? "Member")}
                    {m.is_self ? " (you)" : ""}
                  </span>
                  <RoleChip role={m.role as GroupRole} />
                </li>
              ))}
            </ul>
            {total > Math.min(members.length, SHOWN) && <p className={styles.muted}>+ {total - Math.min(members.length, SHOWN)} more</p>}
          </>
        )}
        <NoDirectMessaging />
      </div>
    </RailCard>
  );
}
