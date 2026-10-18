"use client";

// Ported from old_repo/src/components/community/Post.tsx (lines 50-503)
// A thread in a group feed: the author line (name and company shown by default; "Anonymous member" with the verified mark kept; the id never rendered), the text, edit and delete (the author, and a group admin or moderator
// can delete), report, and the replies. The replies are closed until asked for, 10 at a time, each with the same author line (the old replies drew a legacy name block with no identity), and a failed page of replies says so
// with Retry instead of stopping. A delete asks in the kit Dialog, not window.confirm.
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, Dialog, FormField, Input, StateNote, Textarea } from "@/ui";
import { RelativeTime } from "@/ui";

import { communityApi } from "../../lib/api";
import { LIMITS } from "../../lib/labels";
import type { PostView } from "../../lib/types";
import styles from "../community.module.css";
import { AuthorIdentity, SignedOffMark } from "../parts/AuthorIdentity";
import { useToast } from "../toast";

import { ReplyComposer } from "./ReplyComposer";
import { ReportPostDialog } from "./ReportPostDialog";

function Replies({ post, count, onCount }: { post: PostView; count: number; onCount: (n: number) => void }) {
  const [replies, setReplies] = useState<PostView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "failed">("idle");
  const [identityFailed, setIdentityFailed] = useState(false);
  async function load(after: string | null) {
    setPhase("loading");
    const r = await communityApi.replies(post.id, after);
    if (!r.ok || !r.data) return setPhase("failed");
    setReplies((cur) => [...(after ? (cur ?? []) : []), ...r.data!.replies]);
    setNext(r.data.next_cursor);
    setIdentityFailed(r.data.identity_failed);
    setPhase("idle");
  }
  if (replies === null)
    return (
      <div className={styles.replies}>
        {phase === "failed" ? (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => void load(null) }}>
            The replies could not be loaded.
          </StateNote>
        ) : (
          <Button variant="ghost" size="sm" disabled={phase === "loading"} onClick={() => void load(null)}>
            {phase === "loading" ? "Loading…" : `Show ${count} repl${count === 1 ? "y" : "ies"}`}
          </Button>
        )}
      </div>
    );
  return (
    <div className={styles.replies}>
      {identityFailed && <StateNote tone="error">Author names could not be loaded, so authors show as anonymous.</StateNote>}
      <ul className={styles.plain}>
        {replies.map((r) => (
          <li key={r.id} className={styles.reply}>
            <AuthorIdentity author={r.author} size={28} />
            <p className={styles.body}>{r.body}</p>
            <span className={styles.muted}>
              <RelativeTime iso={r.created_at} />
            </span>
          </li>
        ))}
      </ul>
      {phase === "failed" && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load(next) }}>
          More replies could not be loaded.
        </StateNote>
      )}
      {next && phase !== "failed" && (
        <Button variant="ghost" size="sm" disabled={phase === "loading"} onClick={() => void load(next)}>
          {phase === "loading" ? "Loading…" : "Show more replies"}
        </Button>
      )}
      <ReplyComposer
        postId={post.id}
        onReplied={(reply) => {
          setReplies((cur) => [...(cur ?? []), reply]);
          onCount(count + 1);
        }}
      />
    </div>
  );
}

export function Post({ post: initial, meId, canModerate, onDeleted }: { post: PostView; meId: string; canModerate: boolean; onDeleted: (id: string) => void }) {
  const notify = useToast();
  const [post, setPost] = useState(initial);
  const [count, setCount] = useState(initial.reply_count);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(initial.title ?? "");
  const [body, setBody] = useState(initial.body);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const mine = post.author?.userId === meId;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await communityApi.editPost(post.id, { title: title.trim(), body: body.trim() });
    setBusy(false);
    if (!r.ok || !r.data) return notify(r.error ?? "The post could not be changed.", "error");
    setPost(r.data.post);
    setEditing(false);
    notify("Post updated");
  }
  async function remove() {
    setBusy(true);
    const r = await communityApi.deletePost(post.id);
    setBusy(false);
    if (!r.ok) return notify(r.error ?? "The post could not be deleted.", "error");
    setConfirming(false);
    onDeleted(post.id);
    notify("Post deleted");
  }

  return (
    <article id={`post-${post.id}`} className={styles.post}>
      <header className={styles.postHead}>
        <AuthorIdentity author={post.author} />
        <span className={styles.muted}>
          <RelativeTime iso={post.created_at} />
        </span>
      </header>
      {editing ? (
        <form onSubmit={save} className={styles.composer}>
          <FormField label="Title">{(c) => <Input {...c} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.postTitle} />}</FormField>
          <Textarea aria-label="Post text" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={LIMITS.postBody} />
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || !title.trim() || !body.trim()}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      ) : (
        <>
          <h3 className={styles.postTitle}>{post.title}</h3>
          <p className={styles.body}>{post.body}</p>
        </>
      )}
      {post.signed_off_at && (
        <p className={styles.muted}>
          <SignedOffMark /> A verifier signed this off against a primary document.
        </p>
      )}
      <footer className={styles.postFoot}>
        <Button variant="ghost" size="sm" aria-expanded={repliesOpen} onClick={() => setRepliesOpen((v) => !v)}>
          {formatNumber(count)} repl{count === 1 ? "y" : "ies"}
        </Button>
        {mine && !editing && <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>}
        {(mine || canModerate) && <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>Delete</Button>}
        {!mine && <ReportPostDialog postId={post.id} />}
      </footer>
      {repliesOpen && <Replies post={post} count={count} onCount={setCount} />}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Delete this post">
        <div className={styles.dialogForm}>
          <p>This deletes the thread and its replies. It cannot be undone.</p>
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Keep it</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button>
          </div>
        </div>
      </Dialog>
    </article>
  );
}
