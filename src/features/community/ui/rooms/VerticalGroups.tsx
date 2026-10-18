"use client";

// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 1391-1695)
// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 1697-1758)
// The vertical groups card (member-created groups that cut across the rooms by cargo vertical): the list, "+ New group", the create dialog in the kit Dialog, and the links to the directory and the moderation queue.
// A failed read of the groups is a stated failure with Retry and the links stay. The not-yet-seeded state is said in the member's words (the old copy named a seed script).
import Link from "next/link";
import { useState } from "react";

import { ALL_SECTORS } from "@/core/workspace/vocabulary";
import { Button, Dialog, FormField, Input, Select, SectionCard, Textarea } from "@/ui";

import { communityApi } from "../../lib/api";
import { LIMITS } from "../../lib/labels";
import type { VerticalGroupVM } from "../../lib/rooms-read";
import styles from "../community.module.css";
import { RailRetry } from "../RailRetry";
import { useToast } from "../toast";

export function CreateGroupDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (g: VerticalGroupVM) => void }) {
  const notify = useToast();
  const [name, setName] = useState("");
  const [vertical, setVertical] = useState(ALL_SECTORS[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await communityApi.createGroup({ name: name.trim(), vertical, ...(description.trim() ? { description: description.trim() } : {}) });
    setBusy(false);
    if (!r.ok || !r.data) return setError(r.error ?? "The group could not be created.");
    const g = r.data.group;
    onCreated({ id: g.id, slug: g.slug, name: g.name, vertical, verticalLabel: ALL_SECTORS.find((s) => s.id === vertical)?.label ?? vertical, description: description.trim() || null, memberCount: 1, youOwn: true });
    notify(`Group "${g.name}" created: you own it.`);
    setName("");
    setDescription("");
    onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Start a vertical group">
      <form onSubmit={submit} className={styles.dialogForm}>
        <p className={styles.muted}>A public space that cuts across the regional rooms by cargo vertical. You become its first member and its owner.</p>
        <FormField label="Group name" required>{(c) => <Input {...c} value={name} maxLength={LIMITS.groupName} placeholder="e.g. Fine-art crating & climate control" onChange={(e) => setName(e.target.value)} />}</FormField>
        <FormField label="Cargo vertical" required>
          {(c) => (
            <Select {...c} value={vertical} onChange={(e) => setVertical(e.target.value)}>
              {ALL_SECTORS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Description (optional)">{(c) => <Textarea {...c} rows={3} value={description} maxLength={LIMITS.groupDescription} placeholder="What this group is for, and who should join." onChange={(e) => setDescription(e.target.value)} />}</FormField>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.dialogFoot}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create group"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function VerticalGroups({ groups, onNew }: { groups: VerticalGroupVM[] | null; onNew: () => void }) {
  return (
    <SectionCard>
      <div className={styles.railHead}>
        <p className={styles.eyebrow}>Vertical groups{groups && groups.length > 0 ? ` · ${groups.length}` : ""}</p>
        <Button variant="secondary" size="sm" onClick={onNew}>
          + New group
        </Button>
      </div>
      <div className={styles.railPad}>
        {groups === null ? (
          <RailRetry>The vertical groups could not be loaded.</RailRetry>
        ) : groups.length === 0 ? (
          <p className={styles.muted}>No vertical groups yet. Rooms are regional; a group cuts across them by cargo vertical (fine art, live events, automotive…). Start one and invite peers wherever they operate.</p>
        ) : (
          <ul className={styles.plain}>
            {groups.map((g) => (
              <li key={g.id}>
                <Link href={`/community/${g.slug}`} className={styles.hit}>
                  <span className={styles.hitTitle}>{g.name}</span>
                  <span className={styles.muted}>
                    {g.verticalLabel} · {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                    {g.youOwn ? " · you own this" : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.railLinks}>
          <Link href="/community/browse">Browse all groups →</Link>
          <Link href="/community/moderation">Moderation queue</Link>
        </div>
      </div>
    </SectionCard>
  );
}

/** The state before the seven rooms exist, said in the member's words. */
export function RoomsNotOpen({ isVerifier }: { isVerifier: boolean }) {
  return (
    <SectionCard as="section" aria-label="Regional rooms">
      <div className={styles.pad}>
        <p className={styles.eyebrow}>Regional rooms · not open yet</p>
        <p className={styles.strong}>The seven regional rooms have not been opened on this site yet.</p>
        <p className={styles.muted}>
          Each region (Global, EU, US, UK, Asia–Pacific, Latin America, and Middle East &amp; Africa) opens as a public room where operators post what they see first. Presence, discussions and the live items in each region appear here once
          the rooms exist. {isVerifier ? "You are an active verifier." : "You are not a verifier yet."}
        </p>
      </div>
    </SectionCard>
  );
}
