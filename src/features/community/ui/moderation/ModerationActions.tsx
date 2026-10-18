"use client";

// Ported from old_repo/src/components/community/ModerationActions.tsx (lines 46-402)
// The four actions on an open report: Dismiss, Warn, Remove post, Ban from the group, with a reviewer's note. Remove and Ban ask first in the kit Dialog (the old confirm was its own overlay). Every outcome, success or
// refusal, is TOASTED through the one Toast (the old queue was mounted without its toast callback, so a failed action was silent); the targets are 44 px with room between them. The dead fallback labels are gone.
import { useState } from "react";

import { Button, Dialog, FormField, Textarea } from "@/ui";

import { actOnReport } from "../../lib/actions";
import { communityApi } from "../../lib/api";
import { LIMITS } from "../../lib/labels";
import styles from "../community.module.css";
import { useToast } from "../toast";

type Action = "dismiss" | "warn" | "remove" | "ban";
const CONFIRM: Partial<Record<Action, string>> = {
  remove: "Remove the reported post? This cannot be undone: the post is deleted from the group.",
  ban: "Ban the post's author from this group? They are removed from the member list and cannot rejoin, by invitation or on their own, until the ban is lifted.",
};
const LABEL: Record<Action, string> = { dismiss: "Dismiss", warn: "Warn author", remove: "Remove post", ban: "Ban from group" };

export function ModerationActions({ reportId, onResolved }: { reportId: string; onResolved: () => void }) {
  const notify = useToast();
  const [busy, setBusy] = useState<Action | `mute${1 | 7 | 30}` | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [notes, setNotes] = useState("");
  async function run(action: Action) {
    setBusy(action);
    const done = await actOnReport(communityApi, notify, reportId, action, notes, onResolved);
    setBusy(null);
    if (done) setConfirm(null);
  }
  async function runMute(days: 1 | 7 | 30) {
    setBusy(`mute${days}`);
    await actOnReport(communityApi, notify, reportId, "mute", notes, onResolved, days);
    setBusy(null);
  }
  const pick = (a: Action) => (CONFIRM[a] ? setConfirm(a) : void run(a));
  return (
    <div className={styles.stackTight}>
      <FormField label="Note for the record (optional)">{(c) => <Textarea {...c} rows={2} maxLength={LIMITS.moderationNote} value={notes} onChange={(e) => setNotes(e.target.value)} />}</FormField>
      <div className={styles.actions} role="group" aria-label="Mute the author">
        {([1, 7, 30] as const).map((d) => (
          <Button key={d} variant="secondary" size="sm" disabled={busy !== null} onClick={() => void runMute(d)}>
            {busy === `mute${d}` ? "Working…" : `Mute ${d} ${d === 1 ? "day" : "days"}`}
          </Button>
        ))}
      </div>
      <div className={styles.actions}>
        {(["dismiss", "warn", "remove", "ban"] as const).map((a) => (
          <Button key={a} variant={a === "ban" || a === "remove" ? "danger" : "secondary"} size="sm" disabled={busy !== null} onClick={() => pick(a)}>
            {busy === a ? "Working…" : LABEL[a]}
          </Button>
        ))}
      </div>
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm ? LABEL[confirm] : "Confirm"}>
        <div className={styles.dialogForm}>
          <p>{confirm ? CONFIRM[confirm] : ""}</p>
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => confirm && void run(confirm)}>{busy ? "Working…" : confirm ? LABEL[confirm] : "Confirm"}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
