"use client";

// Ported from old_repo/src/components/community/ReportPostMenu.tsx (lines 42-355)
// Report a post: a button that opens the kit Dialog (focus trap, Esc, focus return) with the reason choice and details. The old menu had its own overlay without a focus trap and an unused render-prop trigger; both are gone.
// The reasons are the one list in labels.ts, also used by the moderation queue.
import { useState } from "react";

import { Button, Dialog, FormField, Select, Textarea } from "@/ui";

import { communityApi } from "../../lib/api";
import { LIMITS, REPORT_REASONS } from "../../lib/labels";
import styles from "../community.module.css";
import { useToast } from "../toast";

export function ReportPostDialog({ postId }: { postId: string }) {
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    const r = await communityApi.report({ post_id: postId, reason, ...(details.trim() ? { body: details.trim() } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "The report could not be sent.");
    notify("Report sent to the group's moderators");
    setOpen(false);
    setReason("");
    setDetails("");
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Report this post">
        Report
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Report this post">
        <form onSubmit={submit} className={styles.dialogForm}>
          <FormField label="Why are you reporting it?" required>
            {(c) => (
              <Select {...c} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Choose a reason</option>
                {REPORT_REASONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Details (optional)">{(c) => <Textarea {...c} rows={3} value={details} maxLength={LIMITS.reportBody} onChange={(e) => setDetails(e.target.value)} />}</FormField>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!reason || busy}>
              {busy ? "Sending…" : "Send report"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
