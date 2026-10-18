"use client";

// Ported from old_repo/src/components/community/CommunityShell.tsx (lines 205-627)
// What /community shows beside the rooms about YOUR groups: pending invitations with Accept and Decline, and your groups as links ("jump back in"). The old tree built this body behind `children ?? <Default/>`, and every
// page passed children, so the invitation panel could never render and no invitation could ever be accepted (the first wiring defect). The rooms page mounts this component, so it is reachable. An answered invitation
// says what happened and links to the group; a refusal shows the server's sentence on the row and as a toast.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, SectionCard, SectionHead } from "@/ui";

import { communityApi } from "../lib/api";
import { regionLabel } from "../lib/labels";
import type { Membership, PendingInvitation } from "../lib/types";

import styles from "./community.module.css";
import { useToast } from "./toast";

type Row = { phase: "idle" } | { phase: "busy"; what: "accept" | "decline" } | { phase: "done"; text: string; slug?: string };

function InvitationRow({ invitation }: { invitation: PendingInvitation }) {
  const router = useRouter();
  const notify = useToast();
  const [row, setRow] = useState<Row>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  async function respond(what: "accept" | "decline") {
    setRow({ phase: "busy", what });
    setError(null);
    const r = await (what === "accept" ? communityApi.acceptInvitation(invitation.id) : communityApi.declineInvitation(invitation.id));
    if (!r.ok) {
      setRow({ phase: "idle" });
      setError(r.error ?? "That did not work.");
      notify(r.error ?? "That did not work.", "error");
      return;
    }
    setRow({ phase: "done", text: what === "accept" ? `You joined ${invitation.group.name}.` : `You declined ${invitation.group.name}.`, ...(what === "accept" ? { slug: invitation.group.slug } : {}) });
    router.refresh();
  }
  if (row.phase === "done")
    return (
      <li className={styles.invitationDone}>
        {row.text} {row.slug && <Link href={`/community/${row.slug}`}>Open the group</Link>}
      </li>
    );
  const busy = row.phase === "busy";
  return (
    <li className={styles.invitation}>
      <div className={styles.grow}>
        <p className={styles.strong}>{invitation.group.name}</p>
        <p className={styles.muted}>
          {invitation.group.privacy === "private" ? "Private group" : "Public forum"} · {regionLabel(invitation.group.region)}
        </p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </div>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond("accept")}>
        {row.phase === "busy" && row.what === "accept" ? "Joining…" : "Accept"}
      </Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void respond("decline")}>
        {row.phase === "busy" && row.what === "decline" ? "Declining…" : "Decline"}
      </Button>
    </li>
  );
}

/** Pending invitations and your groups; draws nothing when you have neither (the rooms are the landing). */
export function CommunityHome({ invitations, memberships, name }: { invitations: PendingInvitation[]; memberships: Membership[]; name: string }) {
  if (invitations.length === 0 && memberships.length === 0) return null;
  const sorted = [...memberships].sort((a, b) => (a.starred === b.starred ? a.group.name.localeCompare(b.group.name) : a.starred ? -1 : 1));
  return (
    <div className={styles.stack}>
      {invitations.length > 0 && (
        <SectionCard as="section" aria-label="Pending invitations">
          <SectionHead title={`Pending invitations (${invitations.length})`} />
          <div className={styles.pad}>
            <p className={styles.muted}>Group admins have invited you to join. Accept to gain access; decline to dismiss.</p>
            <ul className={styles.plain}>
              {invitations.map((inv) => (
                <InvitationRow key={inv.id} invitation={inv} />
              ))}
            </ul>
          </div>
        </SectionCard>
      )}
      {sorted.length > 0 && (
        <SectionCard as="section" aria-label="Your groups">
          <SectionHead title={`Welcome back, ${name}`} />
          <div className={styles.pad}>
            <p className={styles.muted}>Jump back in.</p>
            <ul className={styles.plain}>
              {sorted.map((m) => (
                <li key={m.group_id}>
                  <Link className={styles.hit} href={`/community/${m.group.slug}`}>
                    <span className={styles.hitTitle}>{m.group.name}</span>
                    <span className={styles.muted}>
                      {m.group.member_count} member{m.group.member_count === 1 ? "" : "s"} · {m.group.weekly_post_count} post{m.group.weekly_post_count === 1 ? "" : "s"} this week
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
