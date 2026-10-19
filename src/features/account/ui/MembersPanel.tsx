"use client";

// Ported from old_repo/src/components/profile/MembersPanel.tsx (lines 95-544)
// Ported from old_repo/src/components/profile/MembersPanel.tsx (lines 546-654)
import { useCallback, useEffect, useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { formatLocaleDate } from "@/core/shared";
import { Absence, Button, Dialog, FormCard, FormField, Input, Menu, RowTable, Select, StateNote, Toast } from "@/ui";

import styles from "./account.module.css";

interface Member {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  joined_at: string;
  display_name: string;
}
interface MembersPayload {
  members: Member[];
  caller_role: Member["role"] | "platform_admin";
  /** What the caller may do in this organisation: the database's one answer (org_actions). The panel shows a control only for an action in this list. */
  actions?: string[];
}
interface InviteResult {
  invitation?: { invite_url?: string };
  email_delivery?: { delivered: boolean; configured: boolean; reason?: string };
}
type Flash = { text: string; error: boolean };

const COLUMNS = [
  { label: "Member", width: "1fr" },
  { label: "Joined", width: "120px" },
  { label: "Role", width: "150px" },
  { label: "", width: "44px" },
];
const ROLE_LABELS: Record<Member["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
/** The artboard's joined cell reads "Apr 4 2026": month, day, year without the comma. */
const joined = (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? iso : formatLocaleDate(new Date(iso), { month: "short", day: "numeric", year: "numeric" }).replace(",", ""));

/**
 * Remove and ban, one dialog. Ban is ORG-SCOPED (operator ruling 2026-07-07, migration 156): it removes the member and blocks the account from re-joining this
 * workspace only, and asks for the member's name typed. Remove asks once. Both are the kit's Dialog (Esc, focus kept inside, focus returned).
 */
function MemberActionDialog({ member, kind, pending, onConfirm, onClose }: { member: Member; kind: "remove" | "ban"; pending: boolean; onConfirm: () => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const ban = kind === "ban";
  const ready = !ban || typed.trim() === member.display_name;
  return (
    <Dialog open onClose={pending ? () => undefined : onClose} title={ban ? `Ban ${member.display_name} from this workspace` : `Remove ${member.display_name}`}>
      <div className={styles.stack}>
        <p className={styles.note}>
          {ban
            ? `This removes ${member.display_name} from the workspace and blocks the account from re-joining it; a fresh invitation will not let them back in until the ban is lifted. Their account is unaffected in every other workspace.`
            : `${member.display_name} loses access to this workspace. They can be invited again.`}
        </p>
        {ban ? <FormField label={`Type "${member.display_name}" to confirm`}>{(c) => <Input {...c} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={member.display_name} />}</FormField> : null}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!ready || pending}>
            {pending ? (ban ? "Banning..." : "Removing...") : ban ? `Ban ${member.display_name.split(" ")[0]}` : "Remove"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Members and roles: the table, role changes, invite by e-mail with a copyable link and an honest delivery state, remove and org-scoped ban. A failed read says so with Retry. */
export function MembersPanel({ orgId, callerUserId, callerEmail }: { orgId: string | null; callerUserId: string; callerEmail: string }) {
  const [data, setData] = useState<MembersPayload | null>(null);
  const [invited, setInvited] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [target, setTarget] = useState<{ member: Member; kind: "remove" | "ban" } | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return setLoading(false);
    const [m, i] = await Promise.all([requestJson<MembersPayload>(`/api/orgs/${orgId}/members`), requestJson<{ invitations?: { status?: string }[] }>(`/api/orgs/${orgId}/invitations`)]);
    setData(m.ok ? m.data : null);
    setError(m.ok ? null : m.error);
    // The pending count is secondary: when its read fails the count is not shown, and the table is not blamed for it.
    setInvited(i.ok ? (i.data?.invitations ?? []).filter((x) => x.status === "pending").length : null);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    void load();
  }, [load, attempt]);

  /** One member action: the request, a toast with its outcome, and a reload on success. */
  async function act(member: Member, path: string, init: { method: string; body?: unknown }, done: string, after?: () => void) {
    setBusy(member.id);
    const r = await requestJson(path, init);
    setBusy(null);
    setFlash(r.ok ? { text: done, error: false } : { text: r.error ?? "The change was not saved.", error: true });
    if (r.ok) {
      after?.();
      await load();
    }
  }

  async function sendInvite() {
    if (!orgId || !email.trim()) return;
    setInviting(true);
    setInvite(null);
    const r = await requestJson<InviteResult>(`/api/orgs/${orgId}/invitations`, { method: "POST", body: { email: email.trim(), role: "member" } });
    setInviting(false);
    if (!r.ok) return setFlash({ text: r.error ?? "The invitation was not created.", error: true });
    setInvite(r.data ?? {});
    setFlash({ text: `Invitation created for ${email.trim()}`, error: false });
    setEmail("");
    await load();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setFlash({ text: "Link copied.", error: false });
    } catch {
      setFlash({ text: "The link could not be copied. Select it and copy it by hand.", error: true });
    }
  }

  if (!orgId) return <FormCard title="Members & roles"><p className={styles.muted}>You are not yet a member of any workspace. Member management appears once you join one.</p></FormCard>;
  if (loading) return <FormCard title="Members & roles" aside="Loading..."><p className={styles.muted}>Loading members...</p></FormCard>;
  if (error || !data) {
    return (
      <FormCard title="Members & roles" aside="Not loaded">
        <StateNote tone="error" action={{ label: "Retry", onClick: () => (setLoading(true), setAttempt((n) => n + 1)) }}>
          Members did not load{error ? `: ${error}` : ""}.
        </StateNote>
      </FormCard>
    );
  }

  const can = (action: string): boolean => (data.actions ?? []).includes(action);
  const canInvite = can("invite_member");
  const delivery = invite?.email_delivery;
  const url = invite?.invitation?.invite_url;
  return (
    <>
      <FormCard title="Members & roles" aside={`${data.members.length} member${data.members.length === 1 ? "" : "s"}${invited !== null ? ` · ${invited} invited` : ""} · role changes apply immediately`}>
        {canInvite ? (
          <div className={styles.inviteRow}>
            <FormField label="Invite by email">{(c) => <Input {...c} type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void sendInvite()} />}</FormField>
            <Button variant="primary" onClick={() => void sendInvite()} disabled={inviting || !email.trim()}>
              {inviting ? "Inviting..." : "Send invite"}
            </Button>
          </div>
        ) : null}
        {url ? (
          <div className={styles.inviteBox}>
            <p>
              {delivery?.delivered ? "An email was sent to the invitee. You can also share this link directly:" : delivery?.configured ? `Email delivery failed${delivery.reason ? `: ${delivery.reason}` : ""}. Copy this link and send it to the invitee:` : "Email is not set up on this deployment. Copy this link and send it to the invitee:"}
            </p>
            <div className={styles.inviteUrl}>
              <code className={styles.code}>{url}</code>
              <Button variant="secondary" size="sm" onClick={() => void copy(url)}>
                Copy
              </Button>
            </div>
          </div>
        ) : null}
        <RowTable
          columns={COLUMNS}
          rows={data.members.map((m) => {
            const self = m.user_id === callerUserId;
            return {
              key: m.id,
              cells: [
                <span key="m" style={{ minWidth: 0 }}>
                  <span className={styles.memberName}>{m.display_name}</span>
                  <span className={styles.memberSub}>{self ? `you · ${callerEmail}` : " "}</span>
                </span>,
                <span key="j">{joined(m.joined_at)}</span>,
                can("change_role") ? (
                  <Select key="r" aria-label={`Role for ${m.display_name}`} value={m.role} disabled={busy === m.id} onChange={(e) => void act(m, `/api/orgs/${orgId}/members`, { method: "PATCH", body: { membership_id: m.id, role: e.target.value } }, `${m.display_name} is now ${ROLE_LABELS[e.target.value as Member["role"]]}`)}>
                    {(Object.keys(ROLE_LABELS) as Member["role"][]).map((k) => (
                      <option key={k} value={k}>
                        {ROLE_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <b key="r">{ROLE_LABELS[m.role]}</b>
                ),
                can("remove_member") ? (
                  <Menu key="x" label={`More actions for ${m.display_name}`} items={self ? [] : [{ key: "remove", label: "Remove from workspace", onSelect: () => setTarget({ member: m, kind: "remove" }) }, { key: "ban", label: "Ban from this workspace", onSelect: () => setTarget({ member: m, kind: "ban" }) }]} extra={self ? <span className={styles.note}>You cannot remove or ban your own membership.</span> : undefined} />
                ) : (
                  <span key="x" aria-hidden="true" />
                ),
              ],
            };
          })}
        />
        <p className={styles.note}>Owner · Admin · Member · Viewer. Remove detaches from this workspace; Ban blocks re-joining and asks for typed confirmation. The last owner cannot be removed.</p>
        <StateNote>
          <b>Workspace</b> · your role: {data.caller_role === "platform_admin" ? "Platform admin" : ROLE_LABELS[data.caller_role]} · seat limit <Absence reason="connect data" />
        </StateNote>
      </FormCard>
      {target ? (
        <MemberActionDialog
          member={target.member}
          kind={target.kind}
          pending={busy === target.member.id}
          onClose={() => setTarget(null)}
          onConfirm={() =>
            void act(
              target.member,
              target.kind === "ban" ? `/api/orgs/${orgId}/members` : `/api/orgs/${orgId}/members?membership_id=${encodeURIComponent(target.member.id)}`,
              target.kind === "ban" ? { method: "POST", body: { membership_id: target.member.id } } : { method: "DELETE" },
              target.kind === "ban" ? `Banned ${target.member.display_name} from this workspace` : `Removed ${target.member.display_name}`,
              () => setTarget(null),
            )
          }
        />
      ) : null}
      {flash ? <Toast message={flash.text} variant={flash.error ? "error" : "success"} visible onDismiss={() => setFlash(null)} duration={flash.error ? 6000 : 3000} /> : null}
    </>
  );
}
