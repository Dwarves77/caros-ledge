"use client";

// Ported from old_repo/src/components/community/GroupModals.tsx (lines 454-683)
// Group settings (an admin): name, description and privacy. Making a private group public is the owner's act and cannot be undone for what it exposes (its past discussions open to every signed-in member), so it asks for a
// reason and a typed confirmation and is recorded. The limits are the one pair the create form and the route use. A refusal shows its sentence in the dialog and as a toast.
import { useState } from "react";

import { Button, Dialog, FormField, Input, Segmented, StateNote, Textarea } from "@/ui";

import { communityApi } from "../../lib/api";
import { LIMITS } from "../../lib/labels";
import styles from "../community.module.css";
import { useToast } from "../toast";

interface Editable {
  name: string;
  description: string | null;
  privacy: "public" | "private";
}

export function SettingsDialog({ open, group, onClose, onSaved }: { open: boolean; group: Editable & { id: string }; onClose: () => void; onSaved: (next: Editable) => void }) {
  const notify = useToast();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [privacy, setPrivacy] = useState(group.privacy);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const widening = group.privacy === "private" && privacy === "public";
  const confirmed = !widening || (reason.trim().length > 0 && typed.trim().toLowerCase() === "make public");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await communityApi.saveSettings(group.id, { name: name.trim(), description: description.trim() || null, privacy, ...(group.privacy === "private" && privacy === "public" ? { privacy_reason: reason.trim() } : {}) });
    setBusy(false);
    if (!r.ok || !r.data) {
      const msg = r.error ?? "The settings could not be saved.";
      setError(msg);
      return notify(msg, "error");
    }
    onSaved({ name: r.data.group.name, description: r.data.group.description, privacy: r.data.group.privacy });
    notify("Settings saved");
    onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Group settings">
      <form onSubmit={save} className={styles.dialogForm}>
        <FormField label="Name" required>{(c) => <Input {...c} value={name} maxLength={LIMITS.groupName} onChange={(e) => setName(e.target.value)} />}</FormField>
        <FormField label="Description">{(c) => <Textarea {...c} rows={3} value={description} maxLength={LIMITS.groupDescription} onChange={(e) => setDescription(e.target.value)} />}</FormField>
        <FormField label="Who can read and join" group hint={privacy === "private" ? "Members only. Posts are hidden from non-members." : "Anyone with an account can read and join."}>
          {() => (
            <Segmented
              label="Privacy"
              options={[
                { id: "private", label: "Private" },
                { id: "public", label: "Public" },
              ]}
              selected={[privacy]}
              onSelect={setPrivacy}
            />
          )}
        </FormField>
        {widening && (
          <>
            <StateNote tone="error">Making this group public opens its past discussions to every signed-in member. Only the group&apos;s owner can do this, and it is recorded.</StateNote>
            <FormField label="Why" required>{(c) => <Input {...c} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />}</FormField>
            <FormField label={'Type "make public" to confirm'} required>{(c) => <Input {...c} value={typed} onChange={(e) => setTyped(e.target.value)} />}</FormField>
          </>
        )}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.dialogFoot}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !confirmed}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
