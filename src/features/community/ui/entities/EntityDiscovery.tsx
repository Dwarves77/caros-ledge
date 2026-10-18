"use client";

// Ported from old_repo/src/components/community/EntityDiscoveryPanel.tsx (lines 28-261)
// Follow spine entities (kept on this device only) and read the latest threads about each across every group you can read. A failed read of an entity's threads says so with Retry (the old panel said "Loading" forever);
// the author lines are the shared ones; Unfollow is a 44 px control.
import { useCallback, useEffect, useState } from "react";

import { log } from "@/core/shared/log";
import { Button, StateNote } from "@/ui";

import { communityApi, type EntityThread } from "../../lib/api";
import type { EntityRef } from "../../lib/types";
import styles from "../community.module.css";
import { AuthorIdentity } from "../parts/AuthorIdentity";

import { EntityPicker } from "./EntityPicker";

const STORAGE_KEY = "cl-community-followed-entities-v1";

function readFollowed(): EntityRef[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((e): e is EntityRef => !!e && typeof e.entity_id === "string" && typeof e.kind === "string" && typeof e.canonical_name === "string") : [];
  } catch (e) {
    log.warn("[community] the followed entities on this device could not be read:", e);
    return [];
  }
}

function Digest({ entity, onUnfollow }: { entity: EntityRef; onUnfollow: () => void }) {
  const [threads, setThreads] = useState<EntityThread[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    setThreads(null);
    const r = await communityApi.entityThreads(entity.entity_id);
    if (!r.ok || !r.data) return setFailed(true);
    setThreads(r.data.threads);
  }, [entity.entity_id]);
  useEffect(() => {
    // The first read of an entity's threads is this effect's job; the state it sets is the result of an awaited request.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    void load();
  }, [load]);
  return (
    <section aria-label={`Threads about ${entity.canonical_name}`} className={styles.digest}>
      <div className={styles.digestHead}>
        <h3 className={styles.postTitle}>{entity.canonical_name}</h3>
        <Button variant="ghost" size="sm" aria-label={`Unfollow ${entity.canonical_name}`} onClick={onUnfollow}>
          Unfollow
        </Button>
      </div>
      {failed && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load() }}>
          The threads about this entity could not be loaded.
        </StateNote>
      )}
      {!failed && threads === null && <p className={styles.muted}>Loading…</p>}
      {threads && threads.length === 0 && <p className={styles.muted}>No threads yet.</p>}
      {threads?.map((t) => (
        <article key={t.id} className={styles.digestItem}>
          <p className={styles.strong}>{t.title || t.body.slice(0, 120)}</p>
          <AuthorIdentity author={t.author} size={24} />
          <span className={styles.muted}>
            {t.group_name ? `${t.group_name} · ` : ""}
            {t.reply_count} repl{t.reply_count === 1 ? "y" : "ies"}
          </span>
        </article>
      ))}
    </section>
  );
}

export function EntityDiscovery() {
  const [followed, setFollowed] = useState<EntityRef[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // localStorage exists only in the browser, so the saved follows are read after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    setFollowed(readFollowed());
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(followed));
    } catch (e) {
      log.warn("[community] the followed entities could not be saved on this device:", e);
    }
  }, [followed, ready]);
  return (
    <div className={styles.stack}>
      <div className={styles.pad}>
        <EntityPicker value={followed} onChange={setFollowed} inputId="follow-search" />
        <p className={styles.muted}>Follows are saved on this device only. Each followed entity&rsquo;s most recent threads, across every group you can read, appear below.</p>
      </div>
      {ready && followed.length === 0 && <p className={styles.muted}>Follow a corridor, jurisdiction, instrument, technology or organisation to see every thread that touches it, wherever in Community it was posted.</p>}
      {followed.map((e) => (
        <Digest key={e.entity_id} entity={e} onUnfollow={() => setFollowed((cur) => cur.filter((x) => x.entity_id !== e.entity_id))} />
      ))}
    </div>
  );
}
