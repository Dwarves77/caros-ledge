// The Community test world (P2-16): the shared MemDb with the community row policies emulated in JavaScript (the memory database enforces none), and the new rpcs stood in with the contract their SQL states. The SQL
// itself is proven by the migrations' own self-checks on `npm run schema:local` (0050-0060); these tests prove the route and page layers against that contract, one persona at a time (INV-076).
import assert from "node:assert/strict";

import { ROOMS } from "@/features/community/lib/rooms";

import { scripted } from "../_support/fake-clients.ts";
import { MemDb, SCHEMA, type Row } from "../_support/memdb.ts";

export const PERSONAS = ["anon", "nonMember", "member", "moderator", "admin", "verifier", "platformAdmin", "otherOrg"] as const;
export type Persona = (typeof PERSONAS)[number];
const uid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const USER: Record<Exclude<Persona, "anon">, string> = { nonMember: uid(1), member: uid(2), moderator: uid(3), admin: uid(4), verifier: uid(5), platformAdmin: uid(6), otherOrg: uid(7) };
/** A member who posts anonymously and is not one of the personas. */
export const HIDDEN = uid(8);
/** A signed-in user nobody has met: the person an admin invites. */
export const STRANGER = uid(9);
export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";
export const PUB = "cccccccc-0000-4000-8000-000000000001";
export const PRIV = "cccccccc-0000-4000-8000-000000000002";
export const EXTRA = "cccccccc-0000-4000-8000-000000000003";
export const ROOM_EU = "cccccccc-0000-4000-8000-000000000101";
export const T_ROOM = "dddddddd-0000-4000-8000-000000000011";
export const T_PUB = "dddddddd-0000-4000-8000-000000000001";
export const T_HIDDEN = "dddddddd-0000-4000-8000-000000000002";
export const T_PRIV = "dddddddd-0000-4000-8000-000000000003";
export const R_PUB = "dddddddd-0000-4000-8000-000000000004";
export const R_HIDDEN = "dddddddd-0000-4000-8000-000000000005";
export const REPORT = "eeeeeeee-0000-4000-8000-000000000001";
export const SIGNOFF = "eeeeeeee-0000-4000-8000-000000000002";
export const INVITE = "eeeeeeee-0000-4000-8000-000000000003";
export const ITEM_LIVE = "aaaaaaaa-0000-4000-8000-000000000001";
export const ITEM_DRAFT = "aaaaaaaa-0000-4000-8000-000000000002";
export const ENTITY = "cl:jurisdiction:aaaaaaaaaaaaaaaa";
export const ENTITY_2 = "cl:corridor:bbbbbbbbbbbbbbbb";
export const NOBODY = "99999999-0000-4000-8000-000000000009";

export interface Who {
  uid: string;
  email: string;
  admin: boolean;
}
/** The eight personas, plus the anonymous author of the hidden thread (a viewer of that thread, not a persona of the matrix). */
export type Viewer = Persona | "author";
const whoOf = (p: Viewer): Who | null => (p === "anon" ? null : p === "author" ? { uid: HIDDEN, email: "hidden@example.test", admin: false } : { uid: USER[p], email: `${p}@example.test`, admin: p === "platformAdmin" });
export class PgError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Seeded rows get what an insert would give them: the schema's defaults, and a created_at that moves on every row so ordering is stable. */
export function withDefaults(db: MemDb, table: string, rows: Row[]): Row[] {
  const spec = SCHEMA.tables[table];
  const defaults = Object.fromEntries(Object.entries(spec?.defaults ?? {}).map(([k, v]) => [k, v === "__now" ? db.now : v === "__today" ? db.now.slice(0, 10) : Array.isArray(v) ? [] : v !== null && typeof v === "object" ? {} : v]));
  return rows.map((r) => ({ ...defaults, ...(spec?.columns.includes("created_at") && r.created_at === undefined ? { created_at: db.tick() } : {}), ...r }));
}

const UNIQUE_KEYS: Record<string, string[][]> = {
  community_group_members: [["group_id", "user_id"]],
  community_group_bans: [["group_id", "user_id"]],
  community_group_invitations: [["group_id", "invitee_user_id", "status"]],
  community_post_signoff_requests: [["post_id", "status"]],
  community_member_profiles: [["user_id"]],
  notification_preferences: [["user_id"]],
};

export class World extends MemDb {
  /** rpc name -> message: the call answers an error. */
  override rpcFail = new Map<string, { message: string; code?: string }>();
  rpcLog: string[] = [];
  /** Asks of the auth server for the user (getUser): a page or a route must ask none, the claims are checked locally. */
  authCalls = 0;
  /** Rewrites what community_identity answers (a test hands the projection a row the definer should never send). */
  identityTamper: ((rows: Row[]) => Row[]) | null = null;
  /** What community_directory_counts answers (the SQL's k = 5 floor is its own self-check's; a test can hand the page a cell below it). */
  directory: Row[] | null = [];
  constructor() {
    super({
      ids: "uuid",
      returnRows: true,
      unique: UNIQUE_KEYS,
    });
    this.install();
  }

  override seed(table: string, rows: Row[]): this {
    return super.seed(table, withDefaults(this, table, rows));
  }

  /** The people of the world: the eight personas, the anonymous author and a stranger, each with a profile and a Community profile. Public so a test over another database (the integration fixture) can add them. */
  seedPeople(): Array<{ id: string; name: string; p: string }> {
    const names: Array<[string, string]> = [["member", "Marta Member"], ["moderator", "Mo Moderator"], ["admin", "Ada Admin"], ["verifier", "Vera Verifier"], ["platformAdmin", "Pat Platform"], ["nonMember", "Nina Nonmember"], ["otherOrg", "Olga Other"]];
    const people = [...names.map(([p, n]) => ({ id: USER[p as keyof typeof USER], name: n, p })), { id: HIDDEN, name: "Hidden Hana", p: "hidden" }, { id: STRANGER, name: "Sam Stranger", p: "stranger" }];
    this.seed("profiles", people.map((u) => ({ id: u.id, email: `${u.p}@example.test`, display_name: u.name, full_name: u.name, org_id: u.p === "otherOrg" ? ORG_B : ORG_A, verifier_status: u.p === "verifier" ? "active" : "none", avatar_url: `https://img.example.test/${u.p}.png`, organization: `${u.p} Freight` })));
    this.seed("community_member_profiles", people.map((u) => ({ user_id: u.id, org_type: "forwarder", role: "ops", sector: "air", region: "EU", organisation_key: u.p === "hidden" ? null : `key-${u.p}`, verified: u.p === "member", default_anonymous: u.p === "hidden" })));
    return people;
  }

  private install(): void {
    const people = this.seedPeople();
    this.seed("community_groups", [
      { id: PUB, name: "Air Freight Room", slug: "grp-fine-art-room", region: "EU", privacy: "public", owner_user_id: USER.admin, description: "Air freight", member_count: 3, vertical: "fine-art" },
      { id: PRIV, name: "Private Circle", slug: "grp-private", region: "GLOBAL", privacy: "private", owner_user_id: USER.admin, description: "Closed", member_count: 3, vertical: "fine-art" },
    ]);
    this.seed("community_groups", ROOMS.map((r, i) => ({ id: r.key === "EU" ? ROOM_EU : `cccccccc-0000-4000-8000-00000000010${i + 2}`, name: r.name, slug: r.slug, region: r.regionCode, privacy: "public", owner_user_id: USER.admin, description: r.name, member_count: 1 })));
    this.seed("community_group_members", [{ group_id: ROOM_EU, user_id: USER.member, role: "member" }]);
    this.seed("community_group_members", [PUB, PRIV].flatMap((g) => [{ group_id: g, user_id: USER.member, role: "member" }, { group_id: g, user_id: USER.moderator, role: "moderator" }, { group_id: g, user_id: USER.admin, role: "admin" }, { group_id: g, user_id: HIDDEN, role: "member" }]));
    this.seed("entities", [{ entity_id: ENTITY, kind: "jurisdiction", canonical_name: "European Union" }, { entity_id: ENTITY_2, kind: "corridor", canonical_name: "Rotterdam to Singapore" }]);
    this.seed("community_posts", [
      { id: T_PUB, group_id: PUB, parent_post_id: null, author_user_id: USER.member, title: "ETS surcharge", body: "How are you passing it on?", anonymous: false, reply_count: 1 },
      { id: T_HIDDEN, group_id: PUB, parent_post_id: null, author_user_id: HIDDEN, title: "Quiet question", body: "Anyone seen this?", anonymous: true, reply_count: 0 },
      { id: T_PRIV, group_id: PRIV, parent_post_id: null, author_user_id: USER.member, title: "Private matter", body: "Members only", anonymous: false, reply_count: 0 },
      { id: T_ROOM, group_id: ROOM_EU, parent_post_id: null, author_user_id: USER.member, title: "CBAM reporting window", body: "Who has filed?", anonymous: false, reply_count: 0, last_reply_at: "2026-10-16T10:00:00.000Z" },
      { id: R_PUB, group_id: PUB, parent_post_id: T_PUB, author_user_id: USER.moderator, title: null, body: "We split it.", anonymous: false, reply_count: 0 },
      { id: R_HIDDEN, group_id: PUB, parent_post_id: T_PUB, author_user_id: HIDDEN, title: null, body: "Quietly agreed.", anonymous: true, reply_count: 0 },
    ]);
    this.seed("community_thread_entities", [T_PUB, T_HIDDEN, T_PRIV, T_ROOM].map((t) => ({ thread_id: t, entity_id: ENTITY, entity_kind: "jurisdiction" })));
    this.seed("intelligence_items", [{ id: ITEM_LIVE, title: "Live rule", provenance_status: "verified", is_archived: false, jurisdiction_iso: ["EU"] }, { id: ITEM_DRAFT, title: "Draft rule", provenance_status: "unverified", is_archived: false, jurisdiction_iso: ["EU"] }]);
    this.seed("moderation_reports", [{ id: REPORT, target_kind: "post", target_id: T_PUB, reporter_user_id: USER.member, reason: "spam", status: "open" }]);
    this.seed("community_post_signoff_requests", [{ id: SIGNOFF, post_id: T_PUB, requested_by: USER.member, status: "pending" }]);
    this.seed("community_group_invitations", [{ id: INVITE, group_id: PUB, inviter_user_id: USER.admin, invitee_user_id: USER.nonMember, status: "pending" }]);
    this.seed("org_memberships", people.map((u, i) => ({ id: `ffffffff-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, org_id: u.p === "otherOrg" ? ORG_B : ORG_A, user_id: u.id, role: "member" })));
  }

  role(group: unknown, user: string | null): string | null {
    return (this.rows("community_group_members").find((m) => m.group_id === group && m.user_id === user)?.role as string | undefined) ?? null;
  }
  group(id: unknown): Row | undefined {
    return this.rows("community_groups").find((g) => g.id === id);
  }
  post(id: unknown): Row | undefined {
    return this.rows("community_posts").find((p) => p.id === id);
  }
}

/** The sentence 0063's trigger raises for a muted member (the date as "24 Oct 2026"), or null when they are not muted at `db.now`. */
export function mutedSentence(db: World, group: unknown, user: unknown): string | null {
  const m = db.rows("community_group_members").find((x) => x.group_id === group && x.user_id === user);
  const until = typeof m?.muted_until === "string" ? m.muted_until : null;
  if (!until || Date.parse(until) <= Date.parse(db.now)) return null;
  return `You are muted in this group until ${new Date(until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}.`;
}

// ── the row policies, from supabase/schema.sql and the amending migrations ───────────────────────────────

interface Ctx {
  db: World;
  uid: string | null;
  admin: boolean;
}
const reviewer = (c: Ctx, g: unknown) => ["admin", "moderator"].includes(c.db.role(g, c.uid) ?? "");
const member = (c: Ctx, g: unknown) => c.db.role(g, c.uid) !== null;
const owner = (c: Ctx, g: unknown) => c.db.group(g)?.owner_user_id === c.uid;
const seesGroup = (c: Ctx, g: unknown) => c.db.group(g)?.privacy === "public" || member(c, g);
const verifier = (c: Ctx) => c.db.rows("profiles").some((p) => p.id === c.uid && p.verifier_status === "active") || c.admin;
const postGroup = (c: Ctx, id: unknown) => c.db.post(id)?.group_id;
type Rule = (row: Row, c: Ctx) => boolean;
const POLICY: Record<string, Partial<Record<"select" | "insert" | "update" | "delete", Rule>>> = {
  community_groups: { select: (r, c) => r.privacy === "public" || member(c, r.id), insert: () => true, update: (r, c) => r.owner_user_id === c.uid || c.db.role(r.id, c.uid) === "admin", delete: (r, c) => r.owner_user_id === c.uid || c.db.role(r.id, c.uid) === "admin" },
  community_group_members: { select: (r, c) => r.user_id === c.uid || reviewer(c, r.group_id) || owner(c, r.group_id), insert: (r, c) => c.db.role(r.group_id, c.uid) === "admin", update: (r, c) => r.user_id === c.uid, delete: (r, c) => r.user_id === c.uid || reviewer(c, r.group_id) || owner(c, r.group_id) },
  community_posts: { select: (r, c) => seesGroup(c, r.group_id), insert: (r, c) => member(c, r.group_id) && r.author_user_id === c.uid, update: (r, c) => r.author_user_id === c.uid || reviewer(c, r.group_id), delete: (r, c) => r.author_user_id === c.uid || reviewer(c, r.group_id) },
  community_thread_entities: { select: (r, c) => seesGroup(c, postGroup(c, r.thread_id)) },
  community_group_invitations: { select: (r, c) => r.invitee_user_id === c.uid || r.inviter_user_id === c.uid || reviewer(c, r.group_id) || owner(c, r.group_id), insert: (r, c) => c.db.role(r.group_id, c.uid) === "admin", update: (r, c) => r.invitee_user_id === c.uid || c.db.role(r.group_id, c.uid) === "admin" },
  moderation_reports: { select: (r, c) => r.reporter_user_id === c.uid || c.admin || (r.target_kind === "post" && reviewer(c, postGroup(c, r.target_id))), insert: (r, c) => r.reporter_user_id === c.uid && r.status === "open", update: (r, c) => c.admin || (r.target_kind === "post" && reviewer(c, postGroup(c, r.target_id))) },
  community_post_signoff_requests: { select: (r, c) => r.requested_by === c.uid || verifier(c), insert: (r, c) => r.requested_by === c.uid && member(c, postGroup(c, r.post_id)), update: (r, c) => verifier(c) || (r.requested_by === c.uid && r.status === "pending") },
  community_group_bans: { select: (r, c) => reviewer(c, r.group_id) || c.admin },
  notifications: { select: (r, c) => r.user_id === c.uid, update: (r, c) => r.user_id === c.uid },
  notification_preferences: { select: (r, c) => r.user_id === c.uid, insert: (r, c) => r.user_id === c.uid, update: (r, c) => r.user_id === c.uid },
  community_member_profiles: { select: (_r, c) => c.uid !== null, insert: (r, c) => r.user_id === c.uid, update: (r, c) => r.user_id === c.uid },
};
const DENIED = { data: null, error: { message: "new row violates row-level security policy", code: "42501" }, count: null };

/** `from(table)` for one caller. `rls` false is the service client. The ban guard and the keep-an-admin rule are triggers: they hold for every client. */
function guarded(db: World, who: Who | null, table: string, rls: boolean): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = db.from(table) as any;
  const c: Ctx = { db, uid: who?.uid ?? null, admin: who?.admin === true };
  const deny = (message = DENIED.error.message, code = "42501") => {
    q.run = () => ({ data: null, error: { message, code }, count: null });
  };
  if (table === "community_group_members") {
    const insert = q.insert.bind(q);
    q.insert = (p: Row | Row[]) => {
      const banned = (Array.isArray(p) ? p : [p]).some((r) => db.rows("community_group_bans").some((b) => b.group_id === r.group_id && b.user_id === r.user_id));
      if (banned) deny("This account is banned from the group");
      return insert(p);
    };
    const run = q.run.bind(q);
    q.run = () => {
      if (q.op === "delete") {
        const gone = db.rows(table).filter((r: Row) => q.preds.every((f: Rule) => f(r, c)));
        const last = gone.find((r: Row) => r.role === "admin" && db.group(r.group_id) && !db.rows(table).some((o: Row) => o.group_id === r.group_id && o.role === "admin" && !gone.includes(o)));
        if (last) return { data: null, error: { message: "A group needs at least one admin", code: "22023" }, count: null };
      }
      return run();
    };
  }
  const pol = rls ? POLICY[table] : undefined;
  if (!pol) return q;
  q.preds.push((row: Row) => {
    const rule = q.op === "upsert" ? pol.update : pol[q.op as "select"];
    return rule ? rule(row, c) : q.op === "select" || q.op === "update" || q.op === "delete" ? false : true;
  });
  if (table === "community_posts") {
    const insert = q.insert.bind(q);
    q.insert = (p: Row | Row[]) => {
      const muted = (Array.isArray(p) ? p : [p]).map((r) => mutedSentence(db, r.group_id, r.author_user_id)).find(Boolean);
      if (muted) deny(muted);
      return insert(p);
    };
  }
  if (table === "community_group_members" && rls) {
    const update = q.update.bind(q);
    q.update = (p: Row) => {
      if ("muted_until" in p) deny("A mute is set by a moderator, not by the member");
      return update(p);
    };
  }
  for (const op of ["insert", "upsert"] as const) {
    const original = q[op].bind(q);
    q[op] = (p: Row | Row[], o?: unknown) => {
      if (!pol.insert || (Array.isArray(p) ? p : [p]).some((r) => !pol.insert?.(r, c))) deny();
      return original(p, o);
    };
  }
  return q;
}

/** The listing rpc rows: the verified, live items, in the shape the lists reader maps. */
const listing = (db: World) =>
  db.rows("intelligence_items").filter((i) => i.provenance_status === "verified" && i.is_archived !== true).map((i) => ({ id: i.id, legacy_id: null, title: i.title, domain: 1, effective_priority: "HIGH", added_date: "2026-10-01", full_brief: "x".repeat(50), source_id: null, effective_archived: false, jurisdiction_iso: i.jurisdiction_iso }));

// ── the rpc stand-ins: the contract each function's SQL states ─────────────────────────────────────────

function rpcs(db: World, who: Who | null): Record<string, (a: Record<string, unknown>) => unknown> {
  const c: Ctx = { db, uid: who?.uid ?? null, admin: who?.admin === true };
  const need = (): string => {
    if (!c.uid) throw new PgError("Authentication required", "42501");
    return c.uid;
  };
  const one = (table: string, id: unknown) => db.rows(table).find((r) => r.id === id);
  const insert = (table: string, row: Row): Row => {
    const found = db.tables[table] ?? (db.tables[table] = []);
    const id = db.nextId();
    const made = { id, created_at: db.tick(), ...row };
    found.push(made);
    return made;
  };
  return {
    is_platform_admin: () => c.admin,
    my_profile: () => (need() ? db.rows("profiles").filter((p) => p.id === c.uid) : []),
    community_identity: (a) => {
      need();
      const ids = (a.p_ids as string[] | null) ?? null;
      const q = typeof a.p_query === "string" ? a.p_query.toLowerCase() : null;
      const rows = db.rows("profiles").flatMap((p) => {
        const m = db.rows("community_member_profiles").find((x) => x.user_id === p.id);
        const hide = m?.default_anonymous === true;
        if (ids && !ids.includes(String(p.id))) return [];
        if (q && (hide || !String(p.display_name).toLowerCase().includes(q))) return [];
        return [{ user_id: p.id, display_name: hide ? null : p.display_name, company_name: hide ? null : p.organization, job_title: m?.role ?? null, region: m?.region ?? null, avatar_url: hide ? null : p.avatar_url, verified: m?.verified === true, anonymous: hide }];
      });
      return db.identityTamper ? db.identityTamper(rows) : rows;
    },
    create_group_for_self: (a) => {
      const u = need();
      const name = String(a.p_name ?? "").trim();
      if (!name || name.length > 120) throw new PgError("A group name is 1 to 120 characters", "22023");
      if (db.rows("community_groups").some((g) => g.slug === a.p_slug)) throw new PgError("duplicate key value violates unique constraint", "23505");
      const g = insert("community_groups", { name, slug: a.p_slug, region: "GLOBAL", privacy: "public", owner_user_id: u, vertical: a.p_vertical, description: a.p_description ?? null, member_count: 1, weekly_post_count: 0, last_active_at: db.now });
      db.rows("community_group_members").push({ group_id: g.id, user_id: u, role: "admin", joined_at: db.now, starred: false, muted: false });
      return g;
    },
    accept_group_invitation: (a) => {
      const u = need();
      const inv = one("community_group_invitations", a.p_invitation_id);
      if (!inv) throw new PgError("Invitation not found", "P0002");
      if (inv.invitee_user_id !== u) throw new PgError("Only the invitee can accept this invitation", "42501");
      if (inv.status !== "pending") throw new PgError(`Invitation is ${inv.status}`, "22023");
      if (db.rows("community_group_bans").some((b) => b.group_id === inv.group_id && b.user_id === u)) throw new PgError("This account is banned from the group", "42501");
      if (!db.role(inv.group_id, u)) db.rows("community_group_members").push({ group_id: inv.group_id, user_id: u, role: "member", joined_at: db.now, starred: false, muted: false });
      inv.status = "accepted";
      return inv.group_id;
    },
    create_thread: (a) => {
      const u = need();
      if (!db.role(a.p_group_id, u)) throw new PgError("Only group members may post", "42501");
      const muted = mutedSentence(db, a.p_group_id, u);
      if (muted) throw new PgError(muted, "42501");
      const title = String(a.p_title ?? "").trim();
      const body = String(a.p_body ?? "").trim();
      if (!title || title.length > 200) throw new PgError("A title is 1 to 200 characters", "22023");
      if (!body || body.length > 8000) throw new PgError("A post body is 1 to 8000 characters", "22023");
      const ids = [...new Set(((a.p_entity_ids as string[]) ?? []).map((x) => x.trim()).filter(Boolean))];
      if (ids.length < 1 || ids.length > 10) throw new PgError("A thread binds to 1 to 10 entities", "22023");
      if (ids.some((x) => !/^cl:[a-z_]+:[0-9a-f]{16}$/.test(x))) throw new PgError("An entity id is malformed", "22023");
      if (ids.some((x) => !db.rows("entities").some((e) => e.entity_id === x))) throw new PgError("A chosen entity does not exist", "22023");
      const own = db.rows("community_member_profiles").find((m) => m.user_id === u);
      const anonymous = typeof a.p_anonymous === "boolean" ? a.p_anonymous : own?.default_anonymous === true;
      const post = insert("community_posts", { group_id: a.p_group_id, parent_post_id: null, author_user_id: u, title, body, anonymous, reply_count: 0, last_reply_at: null, signed_off_at: null });
      for (const e of ids) db.rows("community_thread_entities").push({ thread_id: post.id, entity_id: e, entity_kind: db.rows("entities").find((x) => x.entity_id === e)?.kind, created_at: db.tick() });
      return { ...post, entity_ids: ids };
    },
    decide_signoff: (a) => {
      const u = need();
      if (!verifier(c)) throw new PgError("Only active verifiers may record a sign-off decision", "42501");
      if (!["signed_off", "declined"].includes(String(a.p_decision))) throw new PgError("The decision is signed_off or declined", "22023");
      if (a.p_decision === "signed_off" && !String(a.p_primary_doc_url ?? "").trim()) throw new PgError("A sign-off names the primary document it was checked against", "22023");
      const req = one("community_post_signoff_requests", a.p_request_id);
      if (!req) throw new PgError("Sign-off request not found", "P0002");
      if (req.requested_by === u) throw new PgError("Nobody decides their own sign-off request", "42501");
      if (req.status !== "pending") throw new PgError(`This request has already been ${String(req.status).replace("_", " ")}`, "22023");
      Object.assign(req, { status: a.p_decision, verifier_id: u, decided_at: db.now, primary_doc_url: a.p_primary_doc_url ?? null, decision_note: a.p_decision_note ?? null });
      if (a.p_decision === "signed_off") Object.assign(db.post(req.post_id) ?? {}, { signed_off_at: db.now, signed_off_by: u });
      return { ...req };
    },
    moderate_report: (a) => {
      const u = need();
      if (!["dismiss", "warn", "remove", "mute", "ban"].includes(String(a.p_action))) throw new PgError("The action is dismiss, warn, remove, mute or ban", "22023");
      if (a.p_action === "mute" && ![1, 7, 30].includes(Number(a.p_days))) throw new PgError("A mute lasts 1, 7 or 30 days", "22023");
      const rep = one("moderation_reports", a.p_report_id);
      if (!rep) throw new PgError("Report not found", "P0002");
      const post = rep.target_kind === "post" ? db.post(rep.target_id) : undefined;
      const group = post ? post.group_id : rep.target_kind === "group" ? rep.target_id : null;
      if (!((group && ["admin", "moderator"].includes(db.role(group, u) ?? "")) || c.admin)) throw new PgError("Moderator or platform admin access required", "42501");
      if (rep.status !== "open") throw new PgError(`This report is already ${rep.status}`, "22023");
      let notify: unknown = null;
      let until: string | null = null;
      if (a.p_action === "remove") {
        if (!post) throw new PgError("The reported post no longer exists", "P0002");
        db.tables.community_posts = db.rows("community_posts").filter((p) => p.id !== post.id && p.parent_post_id !== post.id);
        notify = post.author_user_id;
      } else if (a.p_action === "warn") {
        notify = post?.author_user_id ?? null;
      } else if (a.p_action === "mute") {
        if (!post?.author_user_id || !group) throw new PgError("There is no member to mute on this report", "22023");
        if (post.author_user_id === u) throw new PgError("You cannot mute yourself", "22023");
        const row = db.rows("community_group_members").find((m) => m.group_id === group && m.user_id === post.author_user_id);
        if (!row) throw new PgError("That person is not a member of this group", "22023");
        until = new Date(Date.parse(db.now) + Number(a.p_days) * 86_400_000).toISOString();
        row.muted_until = until;
        notify = post.author_user_id;
      } else if (a.p_action === "ban") {
        if (!post?.author_user_id || !group) throw new PgError("There is no member to ban on this report", "22023");
        if (post.author_user_id === u) throw new PgError("You cannot ban yourself", "22023");
        db.tables.community_group_members = db.rows("community_group_members").filter((m) => !(m.group_id === group && m.user_id === post.author_user_id));
        db.rows("community_group_bans").push({ group_id: group, user_id: post.author_user_id, banned_by: u, reason: a.p_notes ?? rep.reason, created_at: db.now });
        for (const i of db.rows("community_group_invitations")) if (i.group_id === group && i.invitee_user_id === post.author_user_id && i.status === "pending") i.status = "revoked";
        notify = post.author_user_id;
      }
      Object.assign(rep, { status: a.p_action === "dismiss" ? "dismissed" : "resolved", action: a.p_action, notes: a.p_notes ?? null, resolved_at: db.now, resolved_by_user_id: u });
      return { report_id: rep.id, status: rep.status, action: rep.action, group_id: group, post_id: post?.id ?? null, notify_user_id: notify, muted_until: until };
    },
    // 0103 set_group_privacy: narrowing by the owner or a group admin; widening by the owner alone, with a reason; both leave an event.
    set_group_privacy: (a) => {
      const u = need();
      const g = one("community_groups", a.p_group_id);
      if (!g) throw new PgError("Group not found", "P0002");
      if (g.privacy === a.p_privacy) return { id: g.id, privacy: g.privacy };
      if (a.p_privacy === "private") {
        if (g.owner_user_id !== u && db.role(g.id, u) !== "admin") throw new PgError("Only the owner or a group admin can make a group private", "42501");
      } else {
        if (g.owner_user_id !== u) throw new PgError("Only the owner can make a private group public: its past threads become visible to everyone", "42501");
        if (!String(a.p_reason ?? "").trim()) throw new PgError("A reason is required to make a group public", "22023");
      }
      const from = g.privacy;
      g.privacy = a.p_privacy;
      db.rows("admin_events").push({ id: db.nextId(), actor_id: u, action: a.p_privacy === "public" ? "group_privacy_widened" : "group_privacy_narrowed", target_kind: "community_group", target_id: g.id, reason: a.p_reason ?? null, detail: { from, to: a.p_privacy }, created_at: db.tick() });
      return { id: g.id, privacy: g.privacy };
    },
    // 0103 moderator_remove_post: the report is opened and closed with the note by moderate_report; the author is the one to notify.
    moderator_remove_post: (a) => {
      const u = need();
      const post = db.post(a.p_post_id);
      if (!post) throw new PgError("Post not found", "P0002");
      if (!(["admin", "moderator"].includes(db.role(post.group_id, u) ?? "") || c.admin)) throw new PgError("Moderator or platform admin access required", "42501");
      if (post.author_user_id === u) throw new PgError("Delete your own post directly", "22023");
      const note = String(a.p_notes ?? "").trim();
      if (!note) throw new PgError("A removal needs a note for the author and the record", "22023");
      const rep = insert("moderation_reports", { target_kind: "post", target_id: post.id, reporter_user_id: u, reason: "moderator removal", status: "resolved", action: "remove", notes: note, resolved_at: db.now, resolved_by_user_id: u });
      db.tables.community_posts = db.rows("community_posts").filter((p) => p.id !== post.id && p.parent_post_id !== post.id);
      return { report_id: rep.id, status: "resolved", action: "remove", group_id: post.group_id, post_id: post.id, notify_user_id: post.author_user_id, muted_until: null };
    },
    // 0103 record_domain_verification: service_role only (no session); the verified columns and the event.
    record_domain_verification: (a) => {
      if (c.uid) throw new PgError("permission denied for function record_domain_verification", "42501");
      const row = db.rows("community_member_profiles").find((m) => m.user_id === a.p_user_id);
      const fields = { verified: true, verified_at: db.now, verification_method: "domain-dns", organisation_key: a.p_organisation_key };
      if (row) Object.assign(row, fields);
      else db.rows("community_member_profiles").push({ user_id: a.p_user_id, org_type: "other", default_anonymous: false, ...fields });
      db.rows("admin_events").push({ id: db.nextId(), actor_id: a.p_user_id, action: "member_verified_domain", target_kind: "member", target_id: a.p_user_id, detail: { domain: a.p_domain, evidence: a.p_evidence }, created_at: db.tick() });
      return { verified: true, verified_at: db.now, verification_method: "domain-dns" };
    },
    get_workspace_intelligence_listings_public: () => listing(db),
    get_workspace_intelligence_listings: () => listing(db),
    community_region_counts: (a) =>
      [...db.rows("community_groups").reduce((m, g) => (a.p_privacy && g.privacy !== a.p_privacy ? m : m.set(String(g.region), (m.get(String(g.region)) ?? 0) + 1)), new Map<string, number>())].map(([region, count]) => ({ region, count })),
    community_directory_counts: () => {
      need();
      return db.directory ?? [];
    },
    community_notification_counts: () => {
      const u = need();
      const mine = db.rows("notifications").filter((n) => n.user_id === u && n.read_at == null);
      const by = new Map<string, number>();
      for (const n of mine) {
        const g = (n.payload as { group_id?: string }).group_id ?? "";
        by.set(g, (by.get(g) ?? 0) + 1);
      }
      return [...by].map(([group_id, unread_count]) => ({ group_id: group_id || null, unread_count }));
    },
  };
}

/** A client for one caller. A scripted rpc failure answers an error; a missing rpc answers the "does not exist" error production gives before the migration. */
export function clientFor(db: World, who: Who | null, rls = true) {
  const fns = rpcs(db, who);
  return {
    from: (table: string) => guarded(db, who, table, rls),
    rpc(name: string, args: Record<string, unknown> = {}) {
      db.rpcLog.push(name);
      const answer = (): { data: unknown; error: unknown } => {
        const failure = db.rpcFail.get(name);
        if (failure) return { data: null, error: failure };
        const fn = fns[name];
        if (!fn) return { data: null, error: { message: `Could not find the function public.${name} in the schema cache`, code: "PGRST202" } };
        try {
          return { data: fn(args), error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message, ...(e instanceof PgError ? { code: e.code } : {}) } };
        }
      };
      // PostgREST's rpc builder is chainable: the listing reader ranges it. The stand-in answers the whole list for any range.
      const builder: Record<string, unknown> = { then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject) };
      for (const m of ["range", "limit", "order", "eq", "in", "select", "single", "maybeSingle"]) builder[m] = () => builder;
      return builder;
    },
    auth: {
      async getUser() {
        db.authCalls += 1;
        return { data: { user: who ? { id: who.uid, email: who.email } : null }, error: null };
      },
      async getClaims() {
        return who ? { data: { claims: { sub: who.uid, email: who.email } }, error: null } : { data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing" } };
      },
    },
  } as never;
}

const personaOf = (request?: Request): Viewer => {
  const token = request?.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  return (PERSONAS as readonly string[]).includes(token) || token === "author" ? (token as Viewer) : "anon";
};
/** An existing database (the integration fixture, after its turn) given what a Community test needs: the helpers, the hooks, ids on every insert and the unique keys the real schema holds. */
export function adopt(db: MemDb): World {
  const w = db as World;
  w.rpcFail ??= new Map();
  w.rpcLog ??= [];
  w.authCalls ??= 0;
  w.identityTamper ??= null;
  w.directory ??= [];
  w.role = World.prototype.role;
  w.group = World.prototype.group;
  w.post = World.prototype.post;
  w.seed = World.prototype.seed;
  w.seedPeople = World.prototype.seedPeople;
  w.opts.ids = "uuid";
  w.opts.returnRows = true;
  w.opts.unique = { ...(w.opts.unique ?? {}), ...UNIQUE_KEYS };
  return w;
}
/** Both client factories scripted over `db`: the user client follows the bearer, the service client is the whole database. */
export function wire(db: World): World {
  scripted.user = (request) => clientFor(db, whoOf(personaOf(request)));
  scripted.service = () => clientFor(db, null, false);
  return db;
}

/** A fresh world with both client factories scripted: the user client follows the bearer, the service client is the whole database. */
export function world(): World {
  const db = new World();
  scripted.user = (request) => clientFor(db, whoOf(personaOf(request)));
  scripted.service = () => clientFor(db, null, false);
  return db;
}
export const asClient = (db: World, p: Viewer) => clientFor(db, whoOf(p));
export const serviceOf = (db: World) => clientFor(db, null, false);

export const send = (persona: Viewer, method: string, path: string, body?: unknown) =>
  new Request(`https://app.example.test${path}`, { method, headers: { ...(persona === "anon" ? {} : { authorization: `Bearer ${persona}` }), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
type Handler = (request: Request, context: never) => Promise<Response>;
export async function call(handler: Handler, persona: Viewer, method: string, path: string, body?: unknown, params: Record<string, string> = {}) {
  const res = await handler(send(persona, method, path, body), ctx(params));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { _text: text };
  }
  return { status: res.status, body: json, headers: res.headers };
}
export const E = (...codes: number[]): Record<Persona, number> => Object.fromEntries(PERSONAS.map((p, i) => [p, codes[i]])) as Record<Persona, number>;

/** A persona matrix (INV-076): the status each of the eight personas gets, each against a fresh world. */
export async function matrix(name: string, run: (persona: Persona, db: World) => Promise<number>, expected: Record<Persona, number>): Promise<void> {
  for (const persona of PERSONAS) {
    const db = world();
    assert.equal(await run(persona, db), expected[persona], `${name} as ${persona}`);
  }
}
