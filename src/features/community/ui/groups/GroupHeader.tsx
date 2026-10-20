"use client";

// Ported from old_repo/src/components/community/GroupHeader.tsx (lines 54-470)
// The group page's header: name, privacy, counts, activity (from the request's instant), your role, and the actions: Star and Mute (one toggle, optimistic, put back and TOASTED on a refusal: the old header was mounted
// without its toast callback, so a failed star or mute reverted in silence), Members, and for an admin Invite and Settings. Each is a 44 px control that names its action; the dialogs are the kit's.
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/ui";

import { setGroupPref } from "../../lib/actions";
import { communityApi } from "../../lib/api";
import { canEditGroup } from "../../lib/group-access";
import { isRecentlyActive } from "../../lib/labels";
import type { GroupRole, GroupSummary } from "../../lib/types";
import styles from "../community.module.css";
import { PrivacyPill } from "../parts/PrivacyPill";
import { RoleChip } from "../parts/RoleChip";
import { useToast } from "../toast";

import { InviteDialog } from "./InviteDialog";
import { MembersDialog } from "./MembersDialog";
import { SettingsDialog } from "./SettingsDialog";

export interface HeaderMembership {
  role: GroupRole;
  starred: boolean;
  muted: boolean;
}
type Panel = "members" | "settings" | "invite" | null;

export function GroupHeader({ group, membership, nowIso }: { group: GroupSummary; membership: HeaderMembership | null; nowIso: string }) {
  const router = useRouter();
  const notify = useToast();
  const [starred, setStarred] = useState(membership?.starred ?? false);
  const [muted, setMuted] = useState(membership?.muted ?? false);
  const [busy, setBusy] = useState<"star" | "mute" | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [edited, setEdited] = useState<{ name: string; description: string | null; privacy: "public" | "private" } | null>(null);
  const shown = { ...group, ...(edited ?? {}) };
  const admin = canEditGroup(membership?.role);
  async function toggle(kind: "starred" | "muted") {
    setBusy(kind === "starred" ? "star" : "mute");
    await setGroupPref(communityApi, notify, kind, group.id, !(kind === "starred" ? starred : muted), kind === "starred" ? setStarred : setMuted);
    setBusy(null);
  }
  return (
    <header className={`${styles.groupHead} ${shown.privacy === "private" ? styles.groupHeadPrivate : ""}`}>
      <div className={styles.grow}>
        <h1 className={styles.groupTitle}>{shown.name}</h1>
        <div className={styles.chipRow}>
          <PrivacyPill privacy={shown.privacy} />
          <span className={styles.muted}>
            <b>{group.member_count}</b> member{group.member_count === 1 ? "" : "s"} · <b>{group.weekly_post_count}</b> new post{group.weekly_post_count === 1 ? "" : "s"} this week · {isRecentlyActive(group.last_active_at, nowIso) ? "Active" : "Quiet"}
          </span>
          <RoleChip role={membership?.role} />
        </div>
      </div>
      <div className={styles.actions}>
        {membership && (
          <>
            <Button variant="secondary" size="sm" aria-pressed={starred} disabled={busy === "star"} onClick={() => void toggle("starred")}>
              {starred ? "Starred" : "Star"}
            </Button>
            <Button variant="secondary" size="sm" aria-pressed={muted} disabled={busy === "mute"} onClick={() => void toggle("muted")}>
              {muted ? "Muted" : "Mute"}
            </Button>
          </>
        )}
        <Button variant="secondary" size="sm" onClick={() => setPanel("members")}>Members</Button>
        {admin && <Button variant="secondary" size="sm" onClick={() => setPanel("invite")}>Invite</Button>}
        {admin && <Button variant="secondary" size="sm" onClick={() => setPanel("settings")}>Settings</Button>}
      </div>
      <MembersDialog open={panel === "members"} groupId={group.id} groupName={shown.name} role={membership?.role ?? null} onClose={() => setPanel(null)} onLeft={() => { router.push("/community"); router.refresh(); }} />
      {admin && <InviteDialog open={panel === "invite"} groupId={group.id} groupName={shown.name} onClose={() => setPanel(null)} />}
      {admin && <SettingsDialog open={panel === "settings"} group={{ id: group.id, name: shown.name, description: shown.description ?? null, privacy: shown.privacy }} onClose={() => setPanel(null)} onSaved={setEdited} />}
    </header>
  );
}
