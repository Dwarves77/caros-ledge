"use client";

// Ported from old_repo/src/components/community/GroupModals.tsx (lines 159-452)
// The members roster of a group in the kit Dialog (focus trap, Esc, focus return), and Leave group. A member sees themself; an admin or moderator sees everyone. The roster carries names only (no ids, no contact action),
// with the no-direct-messaging statement; a failed load says so with Retry; the last admin's leave is refused by the database and the sentence shown.
import { useCallback, useEffect, useState } from "react";

import { formatDate } from "@/core/shared";
import { Button, Dialog, StateNote } from "@/ui";

import { communityApi, type MemberView } from "../../lib/api";
import type { GroupRole } from "../../lib/types";
import styles from "../community.module.css";
import { Avatar } from "../parts/Avatar";
import { NoDirectMessaging } from "../parts/NoDirectMessaging";
import { RoleChip } from "../parts/RoleChip";
import { useToast } from "../toast";

export function MembersDialog({ open, groupId, groupName, role, onClose, onLeft }: { open: boolean; groupId: string; groupName: string; role: GroupRole | null; onClose: () => void; onLeft: () => void }) {
  const notify = useToast();
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [state, setState] = useState<{ failed: boolean; identityFailed: boolean; truncated: boolean }>({ failed: false, identityFailed: false, truncated: false });
  const [leaving, setLeaving] = useState(false);
  const load = useCallback(async () => {
    setMembers(null);
    setState((s) => ({ ...s, failed: false }));
    const r = await communityApi.members(groupId);
    if (!r.ok || !r.data) return setState((s) => ({ ...s, failed: true }));
    setMembers(r.data.members);
    setState({ failed: false, identityFailed: r.data.identity_failed, truncated: r.data.truncated });
  }, [groupId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    if (open) void load();
  }, [open, load]);
  async function leave() {
    setLeaving(true);
    const r = await communityApi.leaveGroup(groupId);
    setLeaving(false);
    if (!r.ok) return notify(r.error ?? "You could not leave this group.", "error");
    notify("You left the group");
    onClose();
    onLeft();
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Members of ${groupName}`}>
      <div className={styles.dialogForm}>
        {state.failed && (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => void load() }}>
            The members could not be loaded.
          </StateNote>
        )}
        {!state.failed && members === null && <p className={styles.muted}>Loading members…</p>}
        {state.identityFailed && <StateNote tone="error">Names could not be loaded, so members show without them.</StateNote>}
        {members && members.length === 0 && <p className={styles.muted}>No members are visible to your role.</p>}
        {members && members.length > 0 && (
          <ul className={styles.plain}>
            {members.map((m, i) => (
              <li key={`${m.joined_at}-${i}`} className={styles.personRow}>
                <Avatar name={m.name} url={m.headshot_url} size={32} neutral={m.anonymous} />
                <span className={styles.grow}>
                  {m.anonymous ? "Anonymous member" : (m.name ?? "Member")}
                  {m.is_self ? " (you)" : ""}
                </span>
                {m.muted_until && <span className={styles.chip} title="A moderator muted this member: they can read but not post">Muted until {formatDate(m.muted_until)}</span>}
                <RoleChip role={m.role as GroupRole} />
              </li>
            ))}
          </ul>
        )}
        {state.truncated && <p className={styles.muted}>Showing the first 200 members.</p>}
        <NoDirectMessaging />
        {role && (
          <div className={styles.dialogFoot}>
            <Button variant="danger" disabled={leaving} onClick={() => void leave()}>
              {leaving ? "Leaving…" : "Leave group"}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
