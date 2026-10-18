"use client";

// Ported from old_repo/src/components/community/ReplyComposer.tsx (lines 26-184)
// Reply to a thread (one level deep, 4,000 characters). The refusal's sentence shows under the field and as a toast; a reply that saved but could not notify the thread's author says so.
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, Textarea } from "@/ui";

import { communityApi } from "../../lib/api";
import { LIMITS } from "../../lib/labels";
import type { PostView } from "../../lib/types";
import styles from "../community.module.css";
import { useToast } from "../toast";

export function ReplyComposer({ postId, onReplied }: { postId: string; onReplied: (reply: PostView) => void }) {
  const notify = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !busy && body.trim().length > 0 && body.length <= LIMITS.replyBody;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    const r = await communityApi.reply(postId, body.trim());
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error ?? "The reply could not be sent.");
      notify(r.error ?? "The reply could not be sent.", "error");
      return;
    }
    onReplied(r.data.reply);
    if (!r.data.notified) notify("Reply posted. The thread's author could not be notified.", "error");
    setBody("");
  }
  return (
    <form onSubmit={submit} aria-label="Reply" className={styles.replyForm}>
      <Textarea aria-label="Write a reply" placeholder="Write a reply" rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={LIMITS.replyBody} disabled={busy} />
      <div className={styles.composerFoot}>
        <span className={styles.muted}>
          {formatNumber(body.length)} / {formatNumber(LIMITS.replyBody)}
        </span>
        <Button type="submit" variant="primary" size="sm" disabled={!ok}>
          {busy ? "Replying…" : "Reply"}
        </Button>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </form>
  );
}
