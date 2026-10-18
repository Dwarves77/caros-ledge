// New in P2-16: the seven Community screens as presentation, apart from the reads that feed them. The pages read and hand the data in; the UX smoke's fixture route hands in fixed data, so the screen a member sees is the
// one the smoke measures (at 375 and 1440 px, and against the parity baseline), not a copy of it.
import { formatNumber } from "@/core/shared";
import { Masthead, SectionCard, SectionHead } from "@/ui";
import { PageFrame } from "@/ui/shell";
import { ShellCommandBar } from "@/ui/shell/CommandBar";

import type { RoomsHome } from "../lib/rooms-read";
import type { RosterEntry } from "../lib/roster";
import type { GroupRole, GroupSummary } from "../lib/types";
import styles from "../ui/community.module.css";
import { GroupGrid, type BrowseRow } from "../ui/groups/GroupGrid";
import { GroupHeader } from "../ui/groups/GroupHeader";
import { CommunityHome } from "../ui/Home";
import { MembersRail } from "../ui/MembersRail";
import { EntityDiscovery } from "../ui/entities/EntityDiscovery";
import { ModerationQueue } from "../ui/moderation/ModerationQueue";
import { PeerOrgDirectory, type DirectoryCell } from "../ui/PeerOrgDirectory";
import { PostList } from "../ui/posts/PostList";
import { ProfileForm } from "../ui/ProfileForm";
import { RoomsIndex } from "../ui/rooms/RoomsIndex";
import { ToastProvider } from "../ui/toast";

/** /community: the masthead, your invitations and groups, and the seven rooms. The page keeps the platform nav (the Community sidebar is for the sub-pages). */
export function RoomsScreen({ home, dateLabel, nowIso }: { home: RoomsHome; dateLabel: string; nowIso: string }) {
  const total = home.rooms.reduce((n, r) => n + r.itemCount, 0);
  const known = home.rooms.every((r) => r.itemCountKnown);
  const dek = (
    <span>
      {home.rooms.length} regional room{home.rooms.length === 1 ? "" : "s"}
      {home.seeded ? (
        <>
          {" "}
          · <b>{known ? formatNumber(total) : "—"}</b> active item{total === 1 ? "" : "s"} across them · you are in <b>{home.rooms.filter((r) => r.joined).length}</b>
        </>
      ) : null}{" "}
      · peer signal is unverified until a verifier signs off
    </span>
  );
  return (
    <PageFrame>
      <ToastProvider>
        <div className={styles.stack}>
        <Masthead title="Community" dateLabel={dateLabel} nowIso={nowIso} dek={dek} commandBar={<ShellCommandBar placeholder='Search posts, groups, members — or ask "what did the EU room flag this week?"' />} />
        <CommunityHome invitations={home.invitations} memberships={home.memberships} name={home.me.name} />
        <RoomsIndex rooms={home.rooms} seeded={home.seeded} verticalGroups={home.verticalGroups} failures={home.failures} isVerifier={home.me.verifierStatus === "active"} verifierStatus={home.me.verifierStatus} />
        </div>
      </ToastProvider>
    </PageFrame>
  );
}

/** /community/[slug]: the header, the description, the feed with its composer, and the members rail. */
export function GroupScreen({ group, membership, defaultAnonymous, rail, meId, nowIso }: { group: GroupSummary & { description: string | null }; membership: { role: GroupRole; starred: boolean; muted: boolean } | null; defaultAnonymous: boolean; rail: { members: RosterEntry[]; identityFailed: boolean } | null; meId: string; nowIso: string }) {
  const isReviewer = membership?.role === "admin" || membership?.role === "moderator";
  return (
    <>
      <GroupHeader group={group} membership={membership ? { role: membership.role, starred: !!membership.starred, muted: !!membership.muted } : null} nowIso={nowIso} />
      {group.description && (
        <SectionCard as="section" aria-label="About this group">
          <p className={styles.pad}>{group.description}</p>
        </SectionCard>
      )}
      <div className={styles.groupBody}>
        <div className={styles.grow}>
          <PostList groupId={group.id} meId={meId} isMember={!!membership} canModerate={isReviewer} defaultAnonymous={defaultAnonymous} />
        </div>
        <div className={styles.rail}>
          <MembersRail members={rail ? rail.members : null} total={group.member_count} namesFailed={rail?.identityFailed === true} />
        </div>
      </div>
    </>
  );
}

/** /community/browse: the public groups of a region, each with your state. */
export function BrowseScreen({ regionLabel, rows, nowIso }: { regionLabel: string; rows: BrowseRow[]; nowIso: string }) {
  return (
    <div className={styles.stack}>
      <SectionCard as="section" aria-label="Browse public groups">
        <SectionHead title={`Browse public groups · ${regionLabel}`} />
        <p className={styles.pad}>
          {rows.length} public group{rows.length === 1 ? "" : "s"} here. Private groups are by invitation only and appear in your sidebar once you are in them.
        </p>
      </SectionCard>
      <GroupGrid rows={rows} emptyTitle={`No public groups in ${regionLabel}`} nowIso={nowIso} />
    </div>
  );
}

export function DirectoryScreen({ cells, sectorLabels }: { cells: DirectoryCell[] | null; sectorLabels: ReadonlyMap<string, string> }) {
  return (
    <SectionCard as="section" aria-label="Peer-organisation directory">
      <SectionHead title="Peer-organisation directory" />
      <div className={styles.pad}>
        <PeerOrgDirectory cells={cells} sectorLabels={sectorLabels} />
      </div>
    </SectionCard>
  );
}

export function DiscoverScreen() {
  return (
    <SectionCard as="section" aria-label="Discover by entity">
      <SectionHead title="Discover by entity" />
      <div className={styles.pad}>
        <p className={styles.muted}>Every thread is about at least one entity, so following one shows every thread that touches it, across every group, not just the room it was posted in.</p>
        <EntityDiscovery />
      </div>
    </SectionCard>
  );
}

export function ModerationScreen() {
  return (
    <div className={styles.stack}>
      <SectionCard as="section" aria-label="About the moderation queue">
        <SectionHead title="Moderation queue" />
        <p className={styles.pad}>Reports you filed, reports on posts in groups you moderate, and, for a platform admin, every open report across Community.</p>
      </SectionCard>
      <ModerationQueue />
    </div>
  );
}

export function ProfileScreen() {
  return (
    <div className={styles.stack}>
      <SectionCard as="section" aria-label="About your community profile">
        <SectionHead title="Your community profile" />
        <p className={styles.pad}>Declare your organisation type, role, sector and region, then verify with a company email address to carry the verified mark.</p>
      </SectionCard>
      <ProfileForm />
    </div>
  );
}
