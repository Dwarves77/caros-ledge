"use client";

// Ported from old_repo/src/components/community/GroupModals.tsx (lines 685-1032)
// Invite people to a group (an admin): search by name (two characters or more), invite, and the list of pending invitations with Revoke. A failed search or list says so with Retry, never "no one found"; an invitation
// that saved but could not notify says so. People who are anonymous cannot be found by name (their name is withheld), which the empty result states.
import { useCallback, useEffect, useState } from "react";

import { Button, Dialog, FormField, Input, StateNote } from "@/ui";

import { communityApi } from "../../lib/api";
import styles from "../community.module.css";
import { Avatar } from "../parts/Avatar";
import { useToast } from "../toast";

type Candidate = { user_id: string; name: string; headshot_url: string | null };
type Pending = { id: string; created_at: string; invitee_name: string | null; invitee_avatar: string | null; can_revoke: boolean };

export function InviteDialog({ open, groupId, groupName, onClose }: { open: boolean; groupId: string; groupName: string; onClose: () => void }) {
  const notify = useToast();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [search, setSearch] = useState<"idle" | "loading" | "failed">("idle");
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [pendingFailed, setPendingFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const text = query.trim();

  const loadPending = useCallback(async () => {
    setPendingFailed(false);
    const r = await communityApi.invitations(groupId);
    if (!r.ok || !r.data) return setPendingFailed(true);
    setPending(r.data.invitations);
  }, [groupId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    if (open) void loadPending();
  }, [open, loadPending]);
  useEffect(() => {
    if (!open || text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setSearch("loading");
      void communityApi.candidates(groupId, text).then((r) => {
        if (!live) return;
        setSearch(r.ok ? "idle" : "failed");
        setCandidates(r.ok && r.data ? r.data.candidates : []);
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, groupId, text]);

  async function invite(c: Candidate) {
    setBusy(c.user_id);
    const r = await communityApi.invite(groupId, c.user_id);
    setBusy(null);
    if (!r.ok || !r.data) return notify(r.error ?? "The invitation could not be sent.", "error");
    notify(r.data.notified ? `Invited ${c.name}` : `Invited ${c.name}. They could not be notified, so tell them directly.`, r.data.notified ? "success" : "error");
    setCandidates((cur) => cur.filter((x) => x.user_id !== c.user_id));
    void loadPending();
  }
  async function revoke(p: Pending) {
    setBusy(p.id);
    const r = await communityApi.revokeInvitation(p.id);
    setBusy(null);
    if (!r.ok) return notify(r.error ?? "The invitation could not be withdrawn.", "error");
    notify("Invitation withdrawn");
    setPending((cur) => (cur ?? []).filter((x) => x.id !== p.id));
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Invite to ${groupName}`}>
      <div className={styles.dialogForm}>
        <FormField label="Find a member" hint="Search by name, two characters or more.">{(c) => <Input {...c} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name…" />}</FormField>
        {search === "failed" && <StateNote tone="error">The search did not run. Type again to retry.</StateNote>}
        {text.length >= 2 && search === "idle" && candidates.length === 0 && <p className={styles.muted}>No one matches. Members already in the group, already invited, banned from it, or who keep their name private are not listed.</p>}
        {candidates.length > 0 && (
          <ul className={styles.plain}>
            {candidates.map((c) => (
              <li key={c.user_id} className={styles.personRow}>
                <Avatar name={c.name} url={c.headshot_url} size={32} />
                <span className={styles.grow}>{c.name}</span>
                <Button variant="primary" size="sm" disabled={busy === c.user_id} onClick={() => void invite(c)}>
                  {busy === c.user_id ? "Inviting…" : "Invite"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.eyebrow}>Pending invitations</p>
        {pendingFailed && (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => void loadPending() }}>
            The pending invitations could not be loaded.
          </StateNote>
        )}
        {!pendingFailed && pending === null && <p className={styles.muted}>Loading…</p>}
        {pending && pending.length === 0 && <p className={styles.muted}>No pending invitations.</p>}
        {pending && pending.length > 0 && (
          <ul className={styles.plain}>
            {pending.map((p) => (
              <li key={p.id} className={styles.personRow}>
                <Avatar name={p.invitee_name} url={p.invitee_avatar} size={32} />
                <span className={styles.grow}>{p.invitee_name ?? "A member"}</span>
                {p.can_revoke && (
                  <Button variant="secondary" size="sm" disabled={busy === p.id} onClick={() => void revoke(p)}>
                    {busy === p.id ? "Withdrawing…" : "Revoke"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
