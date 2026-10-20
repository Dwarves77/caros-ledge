"use client";

// New in R2e (M3): the ONE way a post or discussion is deleted. Every surface (the group feed and the rooms) asks here, and it always asks first: a delete is irreversible, and the rooms menu used to delete on one click while the
// feed asked. The author deletes their own post; a moderator removing another member's post must give a note, which goes to the author and to the moderation record (moderate_report).
import { useState } from "react";

import { Button, Dialog, FormField, Textarea } from "@/ui";

import { communityApi } from "../../lib/api";
import { LIMITS } from "../../lib/labels";
import styles from "../community.module.css";
import { useToast } from "../toast";

interface Ask {
  id: string;
  moderator: boolean;
  done: (deleted: boolean) => void;
}

function DeleteDialog({ ask, onClose }: { ask: Ask; onClose: (deleted: boolean) => void }) {
  const notify = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    const r = ask.moderator ? await communityApi.removePost(ask.id, note.trim()) : await communityApi.deletePost(ask.id);
    setBusy(false);
    if (!r.ok) {
      notify(r.error ?? "The post could not be deleted.", "error");
      return;
    }
    notify(ask.moderator ? "Post removed. The author has been told." : "Post deleted");
    onClose(true);
  }
  return (
    <Dialog open onClose={() => (busy ? undefined : onClose(false))} title="Delete this post">
      <div className={styles.dialogForm}>
        <p>This deletes the thread and its replies. It cannot be undone.</p>
        {ask.moderator && <FormField label="Note for the author and the record" required>{(c) => <Textarea {...c} rows={3} value={note} maxLength={LIMITS.moderationNote} onChange={(e) => setNote(e.target.value)} />}</FormField>}
        <div className={styles.dialogFoot}>
          <Button variant="secondary" disabled={busy} onClick={() => onClose(false)}>Keep it</Button>
          <Button variant="danger" disabled={busy || (ask.moderator && !note.trim())} onClick={() => void confirm()}>{busy ? "Deleting…" : "Delete"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** `del(id, moderator)` opens the confirmation and resolves true when the post was deleted; `node` is rendered once by the surface. */
export function useDeletePost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const del = (id: string, moderator: boolean) => new Promise<boolean>((done) => setAsk({ id, moderator, done }));
  const node = ask ? (
    <DeleteDialog
      ask={ask}
      onClose={(deleted) => {
        ask.done(deleted);
        setAsk(null);
      }}
    />
  ) : null;
  return { del, node };
}
