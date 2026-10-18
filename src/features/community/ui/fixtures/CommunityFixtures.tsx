// New in P2-16: the Community screens mounted from fixed data for the UX smoke (tests/ux/community-smoke.mjs), the way the Market and workspace screens are. The screens are the real ones (pages/screens.tsx); only the data is
// a fixture, and `state=failed` hands them every failure the pages can meet. Generic data: no customer, no real group.
import type { Resource } from "@/core/types";

import { ROOMS } from "../../lib/rooms";
import type { RoomsHome } from "../../lib/rooms-read";
import { buildRooms } from "../../lib/rooms-view";
import type { ShellContext } from "../../lib/shell-context";
import type { GroupSummary, Membership } from "../../lib/types";
import { BrowseScreen, DirectoryScreen, DiscoverScreen, GroupScreen, ModerationScreen, ProfileScreen, RoomsScreen } from "../../pages/screens";
import { CommunityLayout } from "../Layout";

const NOW = "2026-10-16T12:00:00.000Z";
const DATE = "Friday, October 16, 2026";
const ME = "00000000-0000-4000-8000-0000000000a1";
const day = (n: number) => new Date(Date.UTC(2026, 9, 16 - n)).toISOString();
const group = (i: number, name: string, over: Partial<GroupSummary> = {}): GroupSummary => ({ id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, name, slug: `fixture-group-${i}`, region: "EU", privacy: "public", member_count: 12 + i, weekly_post_count: 3, last_active_at: day(1), description: "A fixture group about a fixture topic.", vertical: "fine-art", ...over });
const GROUPS = [group(1, "Fine art crating and handling in the Union", { privacy: "public" }), group(2, "Live events touring carnets", { region: "US" }), group(3, "A private circle of fixture operators", { privacy: "private", region: "GLOBAL" }), group(4, "Film and TV equipment, one very long fixture group name that has to wrap inside a phone-width card", { region: "UK" })];
const member = (g: GroupSummary, role: Membership["role"], starred = false): Membership => ({ group_id: g.id, role, starred, muted: false, joined_at: day(30), group: g });

const SHELL: ShellContext = {
  currentUser: { id: ME, email: "smoke@example.invalid", name: "Smoke Member", headshotUrl: null, employer: "Fixture Freight", isPlatformAdmin: false },
  memberships: [member(GROUPS[0] as GroupSummary, "admin", true), member(GROUPS[1] as GroupSummary, "member"), member(GROUPS[2] as GroupSummary, "moderator")],
  invitations: [{ id: "00000000-0000-4000-8000-0000000002a1", group_id: (GROUPS[3] as GroupSummary).id, inviter_user_id: null, created_at: day(2), group: { id: (GROUPS[3] as GroupSummary).id, name: (GROUPS[3] as GroupSummary).name, slug: (GROUPS[3] as GroupSummary).slug, region: "UK", privacy: "public" } }],
  regionCounts: { GLOBAL: 2, EU: 3, US: 1, UK: 1, APAC: 1, HK: 0, LATAM: 0, MEA: 1 },
};

const BANDS = ["CRITICAL", "HIGH", "MODERATE", "LOW"] as const;
const resource = (i: number, jurisdiction: string, topic: string): Resource =>
  ({ id: `fx-${i}`, cat: "ocean", sub: "", title: `Fixture instrument number ${i}`, url: "", note: "", type: "regulation", priority: BANDS[i % 4], added: day(i), reasoning: "", tags: [], whatIsIt: "Fixture", whyMatters: "Fixture", keyData: [], modes: ["ocean"], topic, jurisdiction, jurisdictionIso: [jurisdiction], severity: "monitoring", sourceTier: 2, timeline: [] }) as unknown as Resource;
// The ledger's items by room, with the topics the live site showed on 2026-10-17 as each room's leading themes (the parity baseline's tiles name them).
const THEMES: Array<[string, string[]]> = [["global", ["Research", "Research", "Research", "Fuels", "Fuels", "Corridors"]], ["eu", ["Emissions", "Emissions", "Emissions", "Reporting", "Reporting", "Packaging"]], ["us", ["Reporting", "Reporting", "Reporting", "Emissions", "Emissions", "Transport"]], ["uk", ["Transport", "Transport", "Transport", "Research", "Research", "Emissions"]], ["apac", ["Reporting", "Reporting", "Emissions"]], ["latam", ["Emissions"]]];
const RESOURCES = THEMES.flatMap(([jur, topics], j) => topics.map((t, i) => resource(j * 10 + i, jur, t)));
const author = (name: string | null, anonymous = false) => ({ userId: null, name, company: anonymous ? null : "Fixture Freight", headshotUrl: null, orgType: "forwarder", role: "Operations", sector: "fine-art", region: "EU", verified: true, anonymous });
const POSTS = [
  { id: "00000000-0000-4000-8000-0000000003a1", group_id: "00000000-0000-4000-8000-0000000004a2", title: "Who has filed the first reporting window under the new rules", body: "We are about to file and want to compare notes on the evidence the authority asked for.", reply_count: 4, created_at: day(3), last_reply_at: day(1), referenced_intelligence_item_ids: null, signed_off_at: null, author: author("Ada Fixture") },
  { id: "00000000-0000-4000-8000-0000000003a2", group_id: "00000000-0000-4000-8000-0000000004a2", title: "A claim a verifier has checked", body: "The surcharge applies from the first of the month.", reply_count: 1, created_at: day(5), last_reply_at: null, referenced_intelligence_item_ids: null, signed_off_at: day(4), author: author(null, true) },
];
const ROOM_GROUPS = new Map(ROOMS.map((r, i) => [r.slug, { id: `00000000-0000-4000-8000-0000000004a${i + 1}`, name: r.name, member_count: 20 + i }] as const));

function homeFor(state: string): RoomsHome {
  const failed = state === "failed";
  const threads = state === "threads";
  const rooms = buildRooms({ resources: failed ? [] : RESOURCES, resourcesFailed: failed, threadsFailed: failed, groups: ROOM_GROUPS, joinedGroupIds: new Set(threads ? [ROOM_GROUPS.get("room-eu")?.id ?? ""] : []), posts: threads ? POSTS : [], signoffs: [{ id: "00000000-0000-4000-8000-0000000005a1", post_id: POSTS[0]?.id ?? "", requested_by: ME, status: "pending" as const, created_at: day(1) }].filter(() => threads), requesterNames: new Map([[ME, "Smoke Member"]]), me: { userId: ME, homes: threads ? ["eu"] : [] }, roster: [{ id: ME, name: "Smoke Member", homes: threads ? ["eu"] : [], isOwner: false }] });
  return {
    me: { name: "Smoke Member", avatarUrl: null, verifierStatus: "none", workspaceRole: null, homes: ["eu"], orgId: null },
    rooms,
    seeded: true,
    verticalGroups: failed ? null : GROUPS.slice(0, 3).map((g) => ({ id: g.id, slug: g.slug, name: g.name, vertical: "fine-art", verticalLabel: "Fine Art & Museum Logistics", description: g.description ?? null, memberCount: g.member_count, youOwn: g.id === GROUPS[0]?.id })),
    memberships: SHELL.memberships,
    invitations: SHELL.invitations,
    failures: failed ? ["The latest discussions could not be loaded.", "The ledger counts could not be loaded."] : [],
  };
}

/** One Community screen from fixed data: `rooms`, `group`, `browse`, `directory`, `discover`, `moderation` or `profile`; `state=failed` is every read failed. */
export function CommunityFixtures({ screen, state }: { screen: string; state: string }) {
  const failed = state === "failed";
  if (screen === "rooms") return <div data-fx="community"><RoomsScreen home={homeFor(state)} dateLabel={DATE} nowIso={NOW} /></div>;
  const body =
    screen === "group" ? <GroupScreen group={{ ...(GROUPS[0] as GroupSummary), description: "Handling, crating and customs for fine art moving through the Union." }} membership={{ role: "admin", starred: true, muted: false }} defaultAnonymous={false} rail={failed ? null : { members: [{ role: "admin", joined_at: day(30), muted_until: null, name: "Smoke Member", headshot_url: null, anonymous: false, is_self: true }, { role: "moderator", joined_at: day(20), muted_until: null, name: "Ada Fixture", headshot_url: null, anonymous: false, is_self: false }, { role: "member", joined_at: day(9), muted_until: null, name: null, headshot_url: null, anonymous: true, is_self: false }], identityFailed: false }} meId={ME} nowIso={NOW} />
    : screen === "browse" ? <BrowseScreen regionLabel="European Union" rows={GROUPS.map((g, i) => ({ group: g, state: i === 0 ? ("member" as const) : i === 3 ? ("pending-invite" as const) : ("none" as const) }))} nowIso={NOW} />
    : screen === "directory" ? <DirectoryScreen cells={failed ? null : [{ dimension: "org_region", org_type: "forwarder", region: "EU", sector: "", members: 14, verified_members: 6 }, { dimension: "org_region", org_type: "carrier", region: "US", sector: "", members: 7, verified_members: 2 }, { dimension: "sector", org_type: "", region: "", sector: "fine-art", members: 9, verified_members: 4 }]} sectorLabels={new Map([["fine-art", "Fine Art & Museum Logistics"]])} />
    : screen === "discover" ? <DiscoverScreen />
    : screen === "moderation" ? <ModerationScreen />
    : <ProfileScreen />;
  return (
    <div data-fx="community">
      <CommunityLayout shell={SHELL} nowIso={NOW} dateLabel={DATE} {...(screen === "browse" ? { region: "EU" } : {})}>
        {body}
      </CommunityLayout>
    </div>
  );
}
