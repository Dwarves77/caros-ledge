"use client";

// Ported from old_repo/src/components/community/CommunitySearchResults.tsx (lines 60-429)
// The grouped hits of a Community search, drawn in place of the page. A post hit links to its post, a group hit to the group; a people hit is a name, not a link (nobody is addressed privately). A failed search says so with
// Retry (never "no results"); the loading state is a sentence, not an empty card. The close control is 44 px.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { NEUTRAL_BAND } from "@/core/lists";
import { Button, EmptyState, ListRow, SectionCard, SectionHead, StateNote } from "@/ui";

import { communityApi, type SearchHits } from "../lib/api";

import styles from "./community.module.css";
import { Avatar } from "./parts/Avatar";
import { NoDirectMessaging } from "./parts/NoDirectMessaging";
import { PrivacyPill } from "./parts/PrivacyPill";
import type { SearchScope } from "./SearchBar";

type State = { phase: "loading" } | { phase: "failed"; error: string } | { phase: "ok"; hits: SearchHits };

export function SearchResults({ query, scope, onClose }: { query: string; scope: SearchScope; onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const run = useCallback(() => {
    setState({ phase: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    let live = true;
    void communityApi.search(query, scope).then((r) => {
      if (live) setState(r.ok && r.data ? { phase: "ok", hits: r.data } : { phase: "failed", error: r.error ?? "The search failed." });
    });
    return () => {
      live = false;
    };
  }, [query, scope, attempt]);
  const hits = state.phase === "ok" ? state.hits : null;
  const total = hits ? hits.posts.length + hits.groups.length + hits.people.length : 0;
  return (
    <SectionCard as="section" aria-label="Search results">
      <SectionHead title={`Results for "${query}"`} aside={<Button variant="ghost" size="sm" onClick={onClose}>Close search</Button>} />
      <div className={styles.pad}>
        {state.phase === "loading" && <p className={styles.muted}>Searching…</p>}
        {state.phase === "failed" && (
          <StateNote tone="error" action={{ label: "Retry", onClick: run }}>
            {state.error} Nothing was found because the search did not run.
          </StateNote>
        )}
        {hits && total === 0 && <EmptyState>Nothing in Community matches &ldquo;{query}&rdquo;.</EmptyState>}
        {hits && hits.posts.length > 0 && (
          <section aria-label="Posts">
            <p className={styles.eyebrow}>Posts</p>
            <ul className={styles.plain}>
              {hits.posts.map((p) => (
                <li key={p.id}>
                  <ListRow href={p.group_slug ? `/community/${p.group_slug}#post-${p.id}` : "/community"} band={NEUTRAL_BAND} itemType="post" title={p.title} summary={p.body_excerpt} group={p.group_name ?? "A group you can read"} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {hits && hits.groups.length > 0 && (
          <section aria-label="Groups">
            <p className={styles.eyebrow}>Groups</p>
            <ul className={styles.plain}>
              {hits.groups.map((g) => (
                <li key={g.id}>
                  <Link className={styles.hit} href={`/community/${g.slug}`}>
                    <span className={styles.hitTitle}>{g.name}</span>
                    <span className={styles.muted}>
                      <PrivacyPill privacy={g.privacy} /> {g.member_count} member{g.member_count === 1 ? "" : "s"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {hits && hits.people.length > 0 && (
          <section aria-label="People">
            <p className={styles.eyebrow}>People</p>
            <ul className={styles.plain}>
              {hits.people.map((p, i) => (
                <li key={`${p.name}-${i}`} className={styles.personRow}>
                  <Avatar name={p.name} url={p.headshot_url} size={32} />
                  <span>{p.name}</span>
                </li>
              ))}
            </ul>
            <NoDirectMessaging />
          </section>
        )}
      </div>
    </SectionCard>
  );
}
