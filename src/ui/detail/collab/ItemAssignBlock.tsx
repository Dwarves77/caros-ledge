"use client";

// Ported from old_repo/src/components/detail/ItemAssignBlock.tsx (lines 1-315)
import { useEffect, useState } from "react";

import { formatDate, pluralize } from "@/core/shared";

import { Absence } from "../../Absence";
import { ActionButton } from "../../ActionRow";

import { collabPath, collabRequest, isIdLabel } from "./collab-client";

interface ItemAssignment {
  id: string;
  assignee_user_id: string;
  assignee_name: string | null;
  due_on: string | null;
  state: "open" | "done";
  can_change: boolean;
}
interface Member {
  user_id: string;
  display_name: string;
}
interface ListPayload {
  assignments: ItemAssignment[];
  members: Member[];
  viewer: { role: string; can_write: boolean };
}
interface AssignPayload {
  assignments: ItemAssignment[];
  notified: number;
  notify_failed: number;
}
const people = (n: number): string => `${n} ${pluralize(n, "person", "people")}`;

/** Workspace assignments on one item: several assignees at once, a due date, a notification. `todayIso` is the request's instant (a due date in the past is refused before the call). */
/** A member with no profile name is the Absence token with 'Name not set', never a hash (the roster labels such a member by the first eight id characters: the e-mail is not readable under the authenticated column grant, SEC-5). */
function Who({ name }: { name: string }) {
  return isIdLabel(name) ? (
    <>
      <Absence reason="connect data" variant="dash" /> Name not set
    </>
  ) : (
    <>{name}</>
  );
}

export function ItemAssignBlock({ itemId, todayIso }: { itemId: string; todayIso: string }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<ItemAssignment[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [dueOn, setDueOn] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void collabRequest<ListPayload>(collabPath(itemId, "assignments")).then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setLoadError(res.error);
        setPhase("error");
        return;
      }
      setAssignments(res.data.assignments);
      setMembers(res.data.members);
      setCanWrite(res.data.viewer.can_write);
      setPhase("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, attempt]);

  const assigned = new Set(assignments.map((a) => a.assignee_user_id));
  const available = members.filter((m) => !assigned.has(m.user_id));

  async function assign() {
    if (picked.length === 0 || busy) return;
    if (dueOn && dueOn < todayIso.slice(0, 10)) return setError({ id: "new", message: "The due date is in the past. Choose today or a later date, or clear it." });
    setBusy("new");
    setError(null);
    setFlash(null);
    const res = await collabRequest<AssignPayload>(collabPath(itemId, "assignments"), { method: "POST", body: { assignees: picked, dueOn: dueOn || null } });
    setBusy(null);
    if (!res.ok || !res.data) return setError({ id: "new", message: res.error ?? "That did not save." });
    const made = res.data.assignments;
    setAssignments((prev) => [...prev, ...made]);
    setPicked([]);
    setDueOn("");
    const told = res.data.notify_failed > 0 ? `${res.data.notified} notified, ${res.data.notify_failed} could not be notified` : `${res.data.notified} notified`;
    setFlash(made.length === 0 ? "Those people were already assigned." : `Assigned ${people(made.length)}. ${told}.`);
  }
  async function change(a: ItemAssignment, call: () => Promise<{ ok: boolean; error: string | null }>, said: string) {
    if (busy) return;
    setBusy(a.id);
    setError(null);
    setFlash(null);
    const res = await call();
    setBusy(null);
    if (!res.ok) return setError({ id: a.id, message: res.error ?? "That did not save." });
    setFlash(said);
  }
  const setState = (a: ItemAssignment, state: "open" | "done") =>
    change(a, () => collabRequest<{ assignment: ItemAssignment }>(collabPath(itemId, "assignments"), { method: "PATCH", body: { assignee: a.assignee_user_id, state } }).then((r) => (r.ok && r.data ? (setAssignments((p) => p.map((x) => (x.id === a.id ? r.data!.assignment : x))), r) : r)), state === "done" ? "Marked done." : "Reopened.");
  const remove = (a: ItemAssignment) =>
    change(a, () => collabRequest<{ success: boolean }>(`${collabPath(itemId, "assignments")}?assignee=${encodeURIComponent(a.assignee_user_id)}`, { method: "DELETE" }).then((r) => (r.ok ? (setAssignments((p) => p.filter((x) => x.id !== a.id)), r) : r)), `Removed ${a.assignee_name ?? "the assignee"}.`);

  if (phase === "loading") return <p className="cl-collab-meta">Loading assignments…</p>;
  if (phase === "error") {
    return (
      <div role="alert">
        <p className="cl-collab-meta">{loadError ?? "Assignments could not be loaded."}</p>
        <ActionButton onClick={() => (setPhase("loading"), setAttempt((n) => n + 1))}>Retry</ActionButton>
      </div>
    );
  }
  return (
    <div data-part="item-assignments">
      {assignments.length === 0 ? (
        <p className="cl-collab-meta">Nobody is assigned to this item yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {assignments.map((a) => (
            <li key={a.id} aria-label={`${a.assignee_name ?? "Assignee"}, ${a.state}`} className="cl-collab-item">
              <p className="cl-collab-body">
                <strong data-guard-title>{a.assignee_name ? <Who name={a.assignee_name} /> : "Former member"}</strong>
              </p>
              <p className="cl-collab-meta">
                {a.state === "done" ? "Done" : "Open"}
                {a.due_on ? ` · due ${formatDate(a.due_on)}` : " · no due date"}
              </p>
              {a.can_change && (
                <div className="cl-collab-row">
                  <ActionButton onClick={() => void setState(a, a.state === "done" ? "open" : "done")} disabled={busy !== null}>
                    {busy === a.id ? "Saving…" : a.state === "done" ? "Reopen" : "Mark done"}
                  </ActionButton>
                  <ActionButton onClick={() => void remove(a)} disabled={busy !== null}>
                    Remove
                  </ActionButton>
                </div>
              )}
              {error?.id === a.id && (
                <p role="alert" className="cl-collab-meta">
                  {error.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite" className="cl-collab-meta">
        {flash}
      </p>
      {!canWrite ? (
        <p className="cl-collab-meta">Your role in this workspace can see assignments but not make them.</p>
      ) : available.length === 0 ? (
        <p className="cl-collab-meta">Everyone who can be assigned is already assigned.</p>
      ) : (
        <div>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="cl-detail-label">Assign to</legend>
            <div className="cl-collab-row">
              {available.map((m) => (
                <button key={m.user_id} type="button" className="cl-chip-toggle" aria-pressed={picked.includes(m.user_id)} onClick={() => (setError(null), setPicked((p) => (p.includes(m.user_id) ? p.filter((x) => x !== m.user_id) : [...p, m.user_id])))}>
                  <Who name={m.display_name} />
                </button>
              ))}
            </div>
          </fieldset>
          <label className="cl-detail-label" style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 260, marginTop: 10 }}>
            Due date (optional)
            <input type="date" value={dueOn} onChange={(e) => (setDueOn(e.target.value), setError(null))} className="cl-collab-field" />
          </label>
          <div className="cl-collab-row">
            <ActionButton variant="primary" onClick={() => void assign()} disabled={busy !== null || picked.length === 0}>
              {busy === "new" ? "Assigning…" : picked.length === 0 ? "Assign" : `Assign ${people(picked.length)}`}
            </ActionButton>
            {picked.length === 0 && <span className="cl-collab-meta">Pick at least one person.</span>}
          </div>
          {error?.id === "new" && (
            <p role="alert" className="cl-collab-meta">
              {error.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
