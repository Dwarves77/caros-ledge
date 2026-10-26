"use client";

// Ported from old_repo/src/components/community/GroupCard.tsx (lines 42-408)
// A group tile in the directory: name (a link), privacy and region, description, counts, recent activity, and the join state machine: Join (a public group you are not in), Joined, Pending acceptance (an invitation is
// waiting for you on /community), or By invitation (a private group). The dead "Request to join" button is gone (no request route exists). Activity is measured from the request's instant. A refusal shows on the card and
// as a toast.
import Link from "next/link";
import { useState } from "react";

import { Button, ButtonLink } from "@/ui";

import { communityApi } from "../../lib/api";
import { isRecentlyActive, regionLabel } from "../../lib/labels";
import type { GroupSummary } from "../../lib/types";
import styles from "../community.module.css";
import { PrivacyPill } from "../parts/PrivacyPill";
import { useToast } from "../toast";

export type MembershipState = "none" | "member" | "pending-invite";

export function GroupCard({ group, state: initial, nowIso }: { group: GroupSummary; state: MembershipState; nowIso: string }) {
  const notify = useToast();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function join() {
    setBusy(true);
    setError(null);
    const r = await communityApi.joinGroup(group.id);
    setBusy(false);
    if (!r.ok) {
      const msg = r.error ?? "You could not join this group.";
      setError(msg);
      return notify(msg, "error");
    }
    setState("member");
    notify(`Joined ${group.name}`);
  }
  const recent = isRecentlyActive(group.last_active_at, nowIso);
  return (
    <article className={`${styles.groupCard} ${group.privacy === "private" ? styles.groupCardPrivate : ""}`}>
      <header className={styles.stackTight}>
        <Link href={`/community/${group.slug}`} className={styles.groupName}>
          {group.name}
        </Link>
        <div className={styles.chipRow}>
          <PrivacyPill privacy={group.privacy} />
          <span className={styles.chip}>{regionLabel(group.region)}</span>
        </div>
      </header>
      {group.description && <p className={styles.clamp}>{group.description}</p>}
      <p className={styles.muted}>
        <b>{group.member_count}</b> member{group.member_count === 1 ? "" : "s"} · <b>{group.weekly_post_count}</b> post{group.weekly_post_count === 1 ? "" : "s"} this week · {recent ? "Active recently" : "Quiet"}
      </p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {state === "member" ? (
        <Button variant="secondary" disabled aria-disabled="true">Joined</Button>
      ) : state === "pending-invite" ? (
        <ButtonLink href="/community">
          Pending acceptance: answer on Community
        </ButtonLink>
      ) : group.privacy === "private" ? (
        <Button variant="secondary" disabled aria-disabled="true" title="This group is by invitation only">By invitation</Button>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => void join()}>{busy ? "Joining…" : "Join"}</Button>
      )}
    </article>
  );
}
