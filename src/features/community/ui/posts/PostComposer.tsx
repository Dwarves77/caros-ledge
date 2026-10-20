"use client";

// Ported from old_repo/src/components/community/PostComposer.tsx (lines 84-388)
// Start a thread in a group: title, text, the entities it is about (1 to 10, checked live by the same validator the route runs), a per-post anonymity switch (identity is shown by default; the member's own default
// starts the switch). A post whose words state a commercially sensitive figure (a rate, wage, capacity or pricing figure) is refused by the antitrust guard on the server, with the reason shown in place: the guard reads
// the text, so there is nothing for the member to declare. A refusal and a failure are both said where the member is looking.
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, FormField, Input, Switch, Textarea } from "@/ui";

import { communityApi } from "../../lib/api";
import { entityBindingMessage } from "../../lib/entity-binding";
import { LIMITS } from "../../lib/labels";
import type { EntityRef, PostView } from "../../lib/types";
import styles from "../community.module.css";
import { EntityPicker } from "../entities/EntityPicker";
import { useToast } from "../toast";

export function PostComposer({ groupId, defaultAnonymous, onPosted }: { groupId: string; defaultAnonymous: boolean; onPosted: (post: PostView) => void }) {
  const notify = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [entities, setEntities] = useState<EntityRef[]>([]);
  const [anonymous, setAnonymous] = useState(defaultAnonymous);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const bindingProblem = entityBindingMessage(entities.map((e) => e.entity_id));
  const canSubmit = !busy && title.trim().length > 0 && body.trim().length > 0 && title.length <= LIMITS.postTitle && body.length <= LIMITS.postBody && !bindingProblem;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    const r = await communityApi.createPost({ group_id: groupId, title: title.trim(), body: body.trim(), entity_ids: entities.map((x) => x.entity_id), anonymous });
    setBusy(false);
    if (!r.ok || !r.data) {
      if (r.status === 403) setRefusal(r.error ?? "This post was refused.");
      else setError(r.error ?? "The post could not be sent.");
      return;
    }
    onPosted(r.data.post);
    notify("Posted");
    setTitle("");
    setBody("");
    setEntities([]);
    setAnonymous(defaultAnonymous);
  }

  return (
    <form onSubmit={submit} aria-label="New post" className={styles.composer}>
      <FormField label="Start a post">{(c) => <Input {...c} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={LIMITS.postTitle} disabled={busy} />}</FormField>
      <Textarea aria-label="Post body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Share an update, ask a question, or post resources for this group." rows={4} maxLength={LIMITS.postBody} disabled={busy} />
      <EntityPicker value={entities} onChange={setEntities} disabled={busy} />
      <div className={styles.switchRow}>
        <Switch on={anonymous} onChange={setAnonymous} label="Post anonymously" busy={busy} />
        <span>Post anonymously: your name and company are withheld; the verified-member mark still shows.</span>
      </div>
      <p className={styles.muted}>Posts that state a rate, wage, capacity or pricing figure are refused: an individual figure of that kind is never shared in a post.</p>
      <div className={styles.composerFoot}>
        <span className={body.length > LIMITS.postBody ? styles.error : styles.muted}>
          {formatNumber(body.length)} / {formatNumber(LIMITS.postBody)} characters
        </span>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {busy ? "Posting…" : "Post"}
        </Button>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {refusal && (
        <div role="alert" className={styles.refusal}>
          <p className={styles.strong}>Post refused</p>
          <p>{refusal}</p>
        </div>
      )}
    </form>
  );
}
