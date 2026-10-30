"use client";

// Ported from old_repo/src/components/detail/ItemNotesBlock.tsx (lines 1-297)
import { useEffect, useState } from "react";

import { NOTE_MAX_LENGTH } from "@/core/workspace/limits";
import { formatNumber } from "@/core/shared";

import { Button } from "../../Button";
import { Textarea } from "../../FormField";
import { RelativeTime } from "../../RelativeTime";

import { collabPath, collabRequest } from "./collab-client";

interface ItemNote {
  id: string;
  author_name: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}
interface ListPayload {
  notes: ItemNote[];
  viewer: { role: string; can_write: boolean };
}

/** Workspace notes on one item: add, edit your own, two-step delete. Every write reports its refusal in words and keeps what was typed. A failed load says so with Retry. */
export function ItemNotesBlock({ itemId, request = collabRequest }: { itemId: string; request?: typeof collabRequest }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<ItemNote[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void request<ListPayload>(collabPath(itemId, "notes")).then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setLoadError(res.error);
        setPhase("error");
        return;
      }
      setNotes(res.data.notes);
      setCanWrite(res.data.viewer.can_write);
      setPhase("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, attempt, request]);

  async function run(id: string, call: () => Promise<{ ok: boolean; error: string | null }>, done: () => void, said: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    setFlash(null);
    const res = await call();
    setBusy(null);
    if (!res.ok) return setError({ id, message: res.error ?? "That did not save." });
    done();
    setFlash(said);
  }
  const add = () =>
    run("new", () => request<{ note: ItemNote }>(collabPath(itemId, "notes"), { method: "POST", body: { body: draft.trim() } }).then((r) => (r.ok && r.data ? (setNotes((p) => [r.data!.note, ...p]), r) : r)), () => setDraft(""), "Note added.");
  const save = (id: string, text: string) =>
    run(id, () => request<{ note: ItemNote }>(collabPath(itemId, "notes"), { method: "PATCH", body: { noteId: id, body: text.trim() } }).then((r) => (r.ok && r.data ? (setNotes((p) => p.map((n) => (n.id === id ? r.data!.note : n))), r) : r)), () => setEditing(null), "Note saved.");
  const remove = (id: string) =>
    run(id, () => request<{ success: boolean }>(`${collabPath(itemId, "notes")}?noteId=${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => (r.ok ? (setNotes((p) => p.filter((n) => n.id !== id)), r) : r)), () => setConfirmId(null), "Note deleted.");

  if (phase === "loading") return <p className="cl-collab-meta">Loading notes…</p>;
  if (phase === "error") {
    return (
      <div role="alert" data-part="state-note">
        <p className="cl-collab-meta">{loadError ?? "Notes could not be loaded."}</p>
        <Button onClick={() => (setPhase("loading"), setAttempt((n) => n + 1))}>Retry</Button>
      </div>
    );
  }
  const over = draft.length > NOTE_MAX_LENGTH;
  return (
    <div data-part="item-notes">
      {canWrite ? (
        <div>
          <label htmlFor={`note-draft-${itemId}`} className="cl-detail-label">
            Add a note for your workspace
          </label>
          <Textarea bare id={`note-draft-${itemId}`} value={draft} onChange={(e) => (setDraft(e.target.value), setError(null))} rows={3} className="cl-collab-field" placeholder="Which lanes or clients this touches, who is on it, what was decided" />
          <div className="cl-collab-row">
            <Button onClick={() => void add()} disabled={busy !== null || !draft.trim() || over}>
              {busy === "new" ? "Adding…" : "Add note"}
            </Button>
            <span className="cl-collab-meta">
              {formatNumber(draft.length)} / {formatNumber(NOTE_MAX_LENGTH)}
            </span>
          </div>
          {error?.id === "new" && (
            <p role="alert" className="cl-collab-meta">
              {error.message}
            </p>
          )}
        </div>
      ) : (
        <p className="cl-collab-meta">Your role in this workspace can read notes but not add them.</p>
      )}
      <p role="status" aria-live="polite" className="cl-collab-meta">
        {flash}
      </p>
      {notes.length === 0 ? (
        <p className="cl-collab-meta">No notes on this item yet. Notes are visible to your workspace only, never to other organisations.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {notes.map((n) => (
            <li key={n.id} className="cl-collab-item">
              <p className="cl-collab-meta">
                <strong data-guard-title>{n.author_name ?? "Earlier workspace note"}</strong> · <RelativeTime iso={n.created_at} />
                {n.edited_at ? " · edited" : ""}
              </p>
              {editing?.id === n.id ? (
                <div>
                  <label htmlFor={`note-edit-${n.id}`} className="cl-detail-label">
                    Edit your note
                  </label>
                  <Textarea bare id={`note-edit-${n.id}`} value={editing.text} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} rows={3} className="cl-collab-field" />
                  <div className="cl-collab-row">
                    <Button onClick={() => void save(n.id, editing.text)} disabled={busy !== null || !editing.text.trim() || editing.text.length > NOTE_MAX_LENGTH}>
                      {busy === n.id ? "Saving…" : "Save"}
                    </Button>
                    <Button onClick={() => (setEditing(null), setError(null))} disabled={busy !== null}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="cl-collab-body">{n.body}</p>
              )}
              {error?.id === n.id && (
                <p role="alert" className="cl-collab-meta">
                  {error.message}
                </p>
              )}
              {editing?.id !== n.id && confirmId === n.id && (
                <div role="alertdialog" aria-label="Confirm delete">
                  <p className="cl-collab-meta">Delete this note? It disappears for everyone in your workspace.</p>
                  <div className="cl-collab-row">
                    <Button variant="danger" onClick={() => void remove(n.id)} disabled={busy !== null}>
                      {busy === n.id ? "Deleting…" : "Delete note"}
                    </Button>
                    <Button onClick={() => setConfirmId(null)} disabled={busy !== null}>
                      Keep it
                    </Button>
                  </div>
                </div>
              )}
              {editing?.id !== n.id && confirmId !== n.id && (n.can_edit || n.can_delete) && (
                <div className="cl-collab-row">
                  {n.can_edit && <Button onClick={() => (setEditing({ id: n.id, text: n.body }), setError(null), setConfirmId(null))}>Edit</Button>}
                  {n.can_delete && <Button onClick={() => (setConfirmId(n.id), setError(null))}>Delete</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
