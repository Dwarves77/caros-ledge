"use client";

// Ported from old_repo/src/components/community/PostList.tsx (lines 42-338)
// A group's feed: the composer for members, the newest threads, and "Show older threads" with an honest cursor. A failed load or page says so with Retry (never an empty feed, never a silent stop); the Retry control is 44 px.
// The toast is the layout's one, not a fixed div of its own.
import { useCallback, useEffect, useState } from "react";

import { EmptyState, StateNote } from "@/ui";
import { Button } from "@/ui";

import { communityApi } from "../../lib/api";
import type { PostView } from "../../lib/types";
import styles from "../community.module.css";

import { Post } from "./Post";
import { PostComposer } from "./PostComposer";

export function PostList({ groupId, meId, isMember, canModerate, defaultAnonymous }: { groupId: string; meId: string; isMember: boolean; canModerate: boolean; defaultAnonymous: boolean }) {
  const [posts, setPosts] = useState<PostView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "idle" | "failed">("loading");
  const [identityFailed, setIdentityFailed] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      setPhase("loading");
      const r = await communityApi.posts(groupId, before);
      if (!r.ok || !r.data) return setPhase("failed");
      const page = r.data;
      setPosts((cur) => [...(before ? (cur ?? []) : []), ...page.posts]);
      setNext(page.next_cursor);
      setIdentityFailed(page.identity_failed);
      setPhase("idle");
    },
    [groupId],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    void load(null);
  }, [load]);

  return (
    <div className={styles.stack}>
      {isMember ? <PostComposer groupId={groupId} defaultAnonymous={defaultAnonymous} onPosted={(p) => setPosts((cur) => [p, ...(cur ?? [])])} /> : <EmptyState>Join this group to post.</EmptyState>}
      {identityFailed && <StateNote tone="error">Author names could not be loaded, so authors show as anonymous.</StateNote>}
      {posts === null && phase === "loading" && <p className={styles.muted}>Loading threads…</p>}
      {posts === null && phase === "failed" && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load(null) }}>
          The threads could not be loaded. Nothing has been lost.
        </StateNote>
      )}
      {posts && posts.length === 0 && <EmptyState>No threads here yet. Start the first one.</EmptyState>}
      {posts?.map((p) => (
        <Post key={p.id} post={p} meId={meId} canModerate={canModerate} onDeleted={(id) => setPosts((cur) => (cur ?? []).filter((x) => x.id !== id))} />
      ))}
      {posts && phase === "failed" && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load(next) }}>
          More threads could not be loaded.
        </StateNote>
      )}
      {posts && next && phase !== "failed" && (
        <Button variant="secondary" disabled={phase === "loading"} onClick={() => void load(next)}>
          {phase === "loading" ? "Loading…" : "Show older threads"}
        </Button>
      )}
    </div>
  );
}
