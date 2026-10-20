"use client";

// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 196-1185)
// The regional rooms home: seven room tiles (a wrapping grid, each a button that names the room, its item count, its leading themes and its activity), the selected room's discussion table with in-place disclosure, the
// composer, join and leave, and the rail (who is here, verifier sign-off, why post here, vertical groups). The composer BINDS ENTITIES through the same picker the group feed uses (the old rooms composer sent no entity ids,
// which the route refuses, so no post from here could ever succeed: the second wiring defect), and every action goes through a route and says its failure in the one Toast.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { formatNumber } from "@/core/shared";
import { Absence, Button, CardFoot, Menu, RelativeTime, RowTable, SectionCard, SectionHead, StateNote, Textarea } from "@/ui";

import { citeItem, setMembership } from "../../lib/actions";
import { communityApi } from "../../lib/api";
import { entityBindingMessage } from "../../lib/entity-binding";
import { LIMITS } from "../../lib/labels";
import type { RoomVM, ThreadVM } from "../../lib/rooms-view";
import type { VerticalGroupVM } from "../../lib/rooms-read";
import type { RoomKey } from "../../lib/rooms";
import type { EntityRef, PostView } from "../../lib/types";
import styles from "../community.module.css";
import { EntityPicker } from "../entities/EntityPicker";
import { SignedOffMark } from "../parts/AuthorIdentity";
import { useDeletePost } from "../posts/use-delete-post";
import { useToast } from "../toast";

import { SignoffRail } from "./SignoffRail";
import { ThreadDisclosure, type DisclosureMode } from "./ThreadDisclosure";
import { CreateGroupDialog, RoomsNotOpen, VerticalGroups } from "./VerticalGroups";

export interface RoomsIndexProps {
  rooms: RoomVM[];
  seeded: boolean;
  verticalGroups: VerticalGroupVM[] | null;
  failures: string[];
  isVerifier: boolean;
  verifierStatus: string;
}

const starters = (room: string) => [`What did you see on the ground in ${room} this week?`, `Any handler, berth or documentation behaviour worth flagging in ${room}?`];
const toThread = (p: PostView): ThreadVM => ({ id: p.id, groupId: p.group_id, title: p.title ?? p.body.slice(0, 120), body: p.body, replyCount: 0, createdAt: p.created_at, lastActivityAt: p.created_at, referencedItemIds: [], author: p.author, isYou: true, signedOffAt: null, signedOffDocUrl: null, signoff: null });

export function RoomsIndex({ rooms: initial, seeded, verticalGroups: initialGroups, failures, isVerifier, verifierStatus }: RoomsIndexProps) {
  const router = useRouter();
  const notify = useToast();
  const del = useDeletePost();
  const [rooms, setRooms] = useState(initial);
  const [groups, setGroups] = useState(initialGroups);
  const [selectedKey, setSelectedKey] = useState<RoomKey>(initial.find((r) => r.youHere)?.key ?? initial[0]?.key ?? "EU");
  const [draft, setDraft] = useState("");
  const [entities, setEntities] = useState<EntityRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: string; mode: DisclosureMode } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const selected = rooms.find((r) => r.key === selectedKey) ?? rooms[0];

  const patchRoom = (key: RoomKey, patch: Partial<RoomVM> | ((r: RoomVM) => Partial<RoomVM>)) => setRooms((cur) => cur.map((r) => (r.key === key ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)));
  const patchThread = (id: string, patch: Partial<ThreadVM> | ((t: ThreadVM) => Partial<ThreadVM>)) => selected && patchRoom(selected.key, (r) => ({ threads: r.threads.map((t) => (t.id === id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)) }));
  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  // "Not open yet" is said only when the groups were READ and there are none; a read that failed is a failure, never "not open".
  if (!seeded) {
    return failures.length > 0 ? (
      <div className={styles.roomsBody} data-audit="community-body">
      {del.node}
        <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
          {failures.join(" ")} Nothing has been lost.
        </StateNote>
      </div>
    ) : (
      <RoomsNotOpen isVerifier={isVerifier} />
    );
  }
  if (!selected) return null;
  const bindingProblem = entityBindingMessage(entities.map((e) => e.entity_id));
  const roomName = selected.name;
  const canPost = selected.joined && !!selected.groupId;

  const post = () =>
    guarded(async () => {
      const text = draft.trim();
      if (!text || !selected.groupId || bindingProblem) return;
      const r = await communityApi.createPost({ group_id: selected.groupId, title: text.slice(0, LIMITS.postTitle), body: text, entity_ids: entities.map((e) => e.entity_id) });
      if (!r.ok || !r.data) return notify(r.error ?? "Your post could not be sent.", "error");
      patchRoom(selected.key, (room) => ({ threads: [toThread(r.data!.post), ...room.threads] }));
      setDraft("");
      setEntities([]);
    });
  const toggleJoin = () =>
    guarded(async () => {
      if (!selected.groupId) return;
      if (await setMembership(communityApi, notify, selected.groupId, !selected.joined)) patchRoom(selected.key, { joined: !selected.joined });
    });
  const remove = (t: ThreadVM) =>
    guarded(async () => {
      if (await del.del(t.id, false)) patchRoom(selected.key, (room) => ({ threads: room.threads.filter((x) => x.id !== t.id) }));
    });
  const cite = (t: ThreadVM, item: { uuid: string | null }) =>
    guarded(async () => {
      const cited = await citeItem(communityApi, notify, t.id, item.uuid);
      if (cited) {
        patchThread(t.id, { referencedItemIds: cited });
        setOpen({ id: t.id, mode: "read" });
      }
    });
  const requestSignoff = (t: ThreadVM) =>
    guarded(async () => {
      const r = await communityApi.requestSignoff(t.id);
      if (!r.ok || !r.data) return notify(r.error ?? "The sign-off request could not be sent.", "error");
      patchThread(t.id, { signoff: { requestId: r.data.request.id, status: "pending", isMine: true, requesterName: "You" } });
    });
  const withdraw = (t: ThreadVM) =>
    guarded(async () => {
      if (!t.signoff) return;
      const r = await communityApi.withdrawSignoff(t.signoff.requestId);
      if (!r.ok) return notify(r.error ?? "The request could not be withdrawn.", "error");
      patchThread(t.id, { signoff: null });
    });
  const decide = (t: ThreadVM, decision: "signed_off" | "declined", docUrl?: string) =>
    guarded(async () => {
      if (!t.signoff) return;
      const r = await communityApi.decideSignoff(t.signoff.requestId, decision, undefined, docUrl);
      if (!r.ok || !r.data) return notify(r.error ?? "The decision could not be recorded.", "error");
      patchThread(t.id, decision === "signed_off" ? { signedOffAt: r.data.request.decided_at, signedOffDocUrl: docUrl ?? null, signoff: { ...t.signoff, status: "signed_off" } } : { signoff: { ...t.signoff, status: "declined" } });
    });

  const threads = selected.threads;
  const rows = threads.map((t) => ({
    key: t.id,
    id: `post-${t.id}`,
    activateLabel: `Open ${t.title}`,
    onActivate: () => setOpen((cur) => (cur?.id === t.id ? null : { id: t.id, mode: "read" as const })),
    cells: [
      <span key="j" className={styles.juris}>{roomName.toUpperCase()}</span>,
      <span key="d" className={styles.threadCell}>
        <span className={styles.threadTitle}>{t.title}</span>
        <span className={styles.threadMeta}>
          <Absence reason="connect data" />
          <span>
            Opened by {t.isYou ? "you" : t.author?.anonymous ? "Anonymous member" : (t.author?.name ?? "a member")}
            {t.author?.company && !t.author.anonymous ? ` · ${t.author.company}` : ""}
          </span>
          {t.signedOffAt && <SignedOffMark docUrl={t.signedOffDocUrl} />}
        </span>
      </span>,
      <span key="r"><b>{t.replyCount}</b> <span className={styles.muted}>{t.replyCount === 1 ? "reply" : "replies"}</span></span>,
      <span key="l" className={styles.muted}><RelativeTime iso={t.lastActivityAt} /></span>,
      <Menu
        key="o"
        label={`Actions for ${t.title}`}
        items={[
          { key: "reply", label: "Reply", onSelect: () => setOpen({ id: t.id, mode: "reply" }) },
          ...(t.isYou && selected.liveItems.length > 0 ? [{ key: "cite", label: "Cite source", onSelect: () => setOpen({ id: t.id, mode: "cite" as const }) }] : []),
          ...(!t.signedOffAt && t.signoff?.status !== "pending" ? [{ key: "signoff", label: t.signoff?.status === "declined" ? "Request sign-off again" : "Request verifier sign-off", onSelect: () => void requestSignoff(t) }] : []),
          ...(t.isYou ? [{ key: "delete", label: "Delete discussion", onSelect: () => void remove(t) }] : []),
        ]}
      />,
    ],
    below: open?.id === t.id ? <ThreadDisclosure thread={t} liveItems={selected.liveItems} mode={open.mode} busy={busy} onReplied={() => patchThread(t.id, (cur) => ({ replyCount: cur.replyCount + 1 }))} onCite={(item) => void cite(t, item)} /> : null,
  }));

  return (
    <div className={styles.roomsBody} data-audit="community-body">
      {failures.length > 0 && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
          {failures.join(" ")} Nothing has been lost.
        </StateNote>
      )}
      <div className={styles.roomsGrid}>
        <div className={styles.stack}>
          <div className={styles.tiles}>
            {rooms.map((r) => {
              const last = r.threads[0]?.lastActivityAt;
              const n = r.threads.length;
              return (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={r.key === selectedKey}
                  className={`${styles.tile} ${r.key === selectedKey ? styles.tileOn : ""}`}
                  onClick={() => {
                    setSelectedKey(r.key);
                    setDraft("");
                    setOpen(null);
                  }}
                >
                  <span className={styles.tileHead}>
                    <span className={styles.tileName}>{r.name}</span>
                    <span className={styles.tileCount} style={{ color: r.accent }}>{r.itemCountKnown ? formatNumber(r.itemCount) : "—"}</span>
                  </span>
                  <span className={styles.tileThemes}>{r.themes.length > 0 ? r.themes.join(" · ") : "—"}</span>
                  <span className={styles.tileActivity}>
                    {r.joined && <b>Joined</b>}
                    {r.joined && " · "}
                    {!r.threadsKnown ? "—" : n === 0 ? "no discussions yet" : `${n} discussion${n > 1 ? "s" : ""}${last ? " · " : ""}`}
                    {r.threadsKnown && n > 0 && last ? <RelativeTime iso={last} /> : null}
                  </span>
                </button>
              );
            })}
            <button type="button" className={`${styles.tile} ${styles.tileNew}`} onClick={() => setCreateOpen(true)}>
              + New vertical group
            </button>
          </div>

          <SectionCard dataAudit="room-index">
            <SectionHead title={roomName} aside={`${threads.length} discussion${threads.length === 1 ? "" : "s"} · ${threads.length} shown · ${selected.roster.length} member${selected.roster.length === 1 ? "" : "s"} here`} />
            {threads.length > 0 && <RowTable columns={[{ label: "Juris.", width: "64px" }, { label: "Discussion", width: "minmax(0,1fr)" }, { label: "Replies", width: "96px" }, { label: "Last activity", width: "120px" }, { label: "", width: "44px" }]} rows={rows} metrics={{ paddingLeft: 14, rowMinHeight: 56, ruleAfterLastRow: true }} />}
            <CardFoot
              left={threads.length === 0 ? `Be first in the ${roomName}. No discussions here yet, post what you saw on the ground this week.` : "Threads link to ledger items; the ledger keeps the scoring."}
              right={<Button variant="secondary" onClick={() => composer.current?.focus()}>Start a discussion</Button>}
            />
          </SectionCard>

          <SectionCard dataAudit="new-post">
            <SectionHead title={`New post · ${selected.short}`} aside={`Posts to the ${roomName}`} />
            <div className={styles.pad}>
              <Textarea ref={composer} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Post to the ${roomName}`} placeholder={`Ask the ${roomName}, a lane observation, a handler question, a document worth sharing…`} disabled={!canPost} rows={3} maxLength={LIMITS.postBody} />
              <div className={styles.promptRow}>
                {starters(roomName).map((s) => (
                  <Button key={s} variant="ghost" size="sm" disabled={!selected.joined} onClick={() => setDraft(s)}>
                    {s}
                  </Button>
                ))}
              </div>
              <EntityPicker value={entities} onChange={setEntities} disabled={!canPost} inputId="rooms-entity-search" />
              <div className={styles.composerFoot}>
                <p className={styles.muted}>{selected.joined ? "You are in this room." : "Join the room to post."}</p>
                <Button variant="primary" disabled={busy || !draft.trim() || !canPost || !!bindingProblem} onClick={() => void post()}>
                  Post
                </Button>
              </div>
              <div className={styles.composerFoot}>
                <span />
                <Button variant={selected.joined ? "secondary" : "primary"} disabled={busy || !selected.groupId} onClick={() => void toggleJoin()}>
                  {selected.joined ? "Joined · leave room" : "Join room"}
                </Button>
              </div>
            </div>
          </SectionCard>
        </div>

        <div className={styles.stack}>
          <SectionCard dataAudit="whos-here">
            <div className={styles.railPad}>
              <div className={styles.railHead}>
                <span className={styles.eyebrow}>Who&rsquo;s here · {roomName}</span>
                <span className={styles.muted}>{selected.roster.length}</span>
              </div>
              {selected.roster.length === 0 ? (
                <p className={styles.muted}>No member has this as a home region yet.</p>
              ) : (
                selected.roster.map((m, i) => (
                  <div key={i} className={styles.personRow}>
                    <span className={styles.grow}>
                      <b>{m.name}</b>
                      {m.isYou ? " (you)" : ""}
                    </span>
                    {m.isOwner && <span className={styles.chip}>Owner</span>}
                  </div>
                ))
              )}
              <p className={styles.muted}>
                Presence comes from profile home jurisdictions. Grow the network by <Link href="/profile" className={styles.inlineLink}>workspace invitation</Link>.
              </p>
            </div>
          </SectionCard>
          <SignoffRail threads={threads} isVerifier={isVerifier} verifierStatus={verifierStatus} busy={busy} onWithdraw={(t) => void withdraw(t)} onDecide={(t, d) => void decide(t, d)} />
          <SectionCard dataAudit="why-post-here">
            <div className={styles.railPad}>
              <p className={styles.eyebrow}>Why post here</p>
              <p className={styles.muted}>The ledger prints what&rsquo;s verified. The room holds what operators know first: handler capacity, berth behaviour, what a regulator said on a call. Community is a social place, not a source of information.</p>
            </div>
          </SectionCard>
          <VerticalGroups groups={groups} onNew={() => setCreateOpen(true)} />
        </div>
      </div>
      <CreateGroupDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(g) => setGroups((cur) => [g, ...(cur ?? [])])} />
    </div>
  );
}
