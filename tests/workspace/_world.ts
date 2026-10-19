import assert from "node:assert/strict";

import { scripted } from "../_support/fake-clients.ts";

import { memClient, MemDb, type Row, type Who } from "./_memdb.ts";

export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";
export const ITEM_1 = "aaaaaaaa-0000-4000-8000-000000000001";
export const ITEM_2 = "aaaaaaaa-0000-4000-8000-000000000002";
export const ITEM_ARCHIVED = "aaaaaaaa-0000-4000-8000-000000000003";

export type Persona = "anon" | "viewer" | "member" | "admin" | "owner" | "otherOrgMember" | "platformAdmin";
export const PERSONAS: Persona[] = ["anon", "viewer", "member", "admin", "owner", "otherOrgMember", "platformAdmin"];
const uid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const USER: Record<Exclude<Persona, "anon">, string> = { viewer: uid(1), member: uid(2), admin: uid(3), owner: uid(4), otherOrgMember: uid(5), platformAdmin: uid(6) };
/** A second member of org A who is not one of the personas (the "other teammate"). */
export const TEAMMATE = uid(7);
/** A member of org B who also watches item 1. */
export const OUTSIDER = USER.otherOrgMember;
const ROLE: Record<string, { org: string; role: string }> = {
  viewer: { org: ORG_A, role: "viewer" },
  member: { org: ORG_A, role: "member" },
  admin: { org: ORG_A, role: "admin" },
  owner: { org: ORG_A, role: "owner" },
  otherOrgMember: { org: ORG_B, role: "owner" },
};

export function seed(): MemDb {
  const profiles = Object.entries({ ...USER, teammate: TEAMMATE }).map(([name, id]) => ({ id, full_name: `Name ${name}`, display_name: null, email: `${name}@example.test`, avatar_url: null }));
  const memberships: Row[] = [
    ...Object.entries(ROLE).map(([persona, r], i) => ({ id: `cccccccc-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, org_id: r.org, user_id: USER[persona as keyof typeof USER], role: r.role, created_at: `2026-01-0${i + 1}T00:00:00Z` })),
    { id: "cccccccc-0000-4000-8000-000000000099", org_id: ORG_A, user_id: TEAMMATE, role: "member", created_at: "2026-02-01T00:00:00Z" },
  ];
  const db = new MemDb({
    profiles,
    org_memberships: memberships,
    organizations: [{ id: ORG_A, name: "Org A", slug: "org-a" }, { id: ORG_B, name: "Org B", slug: "org-b" }],
    workspace_settings: [
      { id: "dddddddd-0000-4000-8000-000000000001", org_id: ORG_A, sector_profile: [], jurisdiction_weights: null, default_filters: {}, alert_config: { priorities: ["CRITICAL", "HIGH"] }, home_sections: {}, default_export_format: "html", profile: { roles: ["freight operator"] }, updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "dddddddd-0000-4000-8000-000000000002", org_id: ORG_B, sector_profile: [], jurisdiction_weights: null, default_filters: {}, alert_config: {}, home_sections: {}, default_export_format: "html", profile: {}, updated_at: "2026-01-01T00:00:00.000Z" },
    ],
    intelligence_items: [
      { id: ITEM_1, legacy_id: "o3", title: "FuelEU Maritime", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, priority: "HIGH", origin_class: "official" },
      { id: ITEM_2, legacy_id: "o4", title: "ReFuelEU Aviation", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, priority: "CRITICAL", origin_class: "official" },
      { id: ITEM_ARCHIVED, legacy_id: "o9", title: "Old rule", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: true, priority: "LOW", origin_class: null },
    ],
    user_watchlist: [
      { id: "w1", user_id: USER.member, item_id: "o3" },
      { id: "w2", user_id: OUTSIDER, item_id: ITEM_1 },
    ],
    org_watchlist: [],
  });
  installSqlObjects(db);
  return db;
}

/** The migration-0023 and 0024 objects, emulated over the rows exactly as the SQL defines them (the SQL itself is proven by the migrations' self-checks). */
function installSqlObjects(db: MemDb): void {
  const JSONB = ["profile", "alert_config", "home_sections", "default_filters", "jurisdiction_weights"];
  const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  // patch_workspace_settings: one atomic top-level merge; null when no row. Logged as one update so a test can count writes.
  db.scriptRpc("patch_workspace_settings", (args) => {
    const { p_org_id, p_column, p_patch } = args as { p_org_id: string; p_column: string; p_patch: Record<string, unknown> };
    if (!JSONB.includes(p_column) || !isObj(p_patch)) throw new Error("patch_workspace_settings: refused");
    db.log.push({ table: "workspace_settings", op: "update", payload: { [p_column]: p_patch }, filters: [["eq", "org_id", p_org_id]] });
    const failure = db.takeFailure("workspace_settings", "update", [["eq", "org_id", p_org_id]]);
    if (failure) throw new Error(failure.message);
    const row = db.rows("workspace_settings").find((r) => r.org_id === p_org_id);
    if (!row) return null;
    row[p_column] = { ...(isObj(row[p_column]) ? (row[p_column] as object) : {}), ...p_patch };
    row.updated_at = db.tick();
    return row[p_column];
  });
  // archive_item_for_team and assign_item (migration 0037): the gate, the attribution from the session, the override write and the outbox rows as ONE unit: a failed outbox insert leaves no override behind.
  const raise = (message: string, code: string) => Object.assign(new Error(message), { code });
  const roleOf = (org: unknown, uid: unknown) => db.rows("org_memberships").find((m) => m.org_id === org && m.user_id === uid)?.role as string | undefined;
  const override = (org: unknown, item: unknown): Row | undefined => db.rows("workspace_item_overrides").find((r) => r.org_id === org && r.item_id === item);
  const caller = (who: Who | null): string => {
    const id = who?.claims?.sub;
    if (!id) throw raise("sign in", "42501");
    return id;
  };
  const commit = (org: unknown, item: unknown, patch: Row, notices: { user_id: string; kind: string; payload: Record<string, unknown> }[]) => {
    if (notices.length && db.takeFailure("notification_outbox", "insert", [])) throw raise("outbox down", "XX000");
    const prior = override(org, item);
    const row = prior ?? { org_id: org, item_id: item };
    Object.assign(row, patch, { updated_at: db.tick() });
    if (!prior) db.rows("workspace_item_overrides").push(row);
    db.log.push({ table: "workspace_item_overrides", op: "upsert", payload: patch, filters: [["eq", "org_id", org], ["eq", "item_id", item]] });
    for (const n of notices) db.rows("notification_outbox").push({ ...n });
    if (notices.length) db.log.push({ table: "notification_outbox", op: "insert", payload: notices, filters: [] });
    return { override: { ...row }, queued: notices.length };
  };
  db.scriptRpc("archive_item_for_team", (args, who) => {
    const { p_org_id, p_item_id, p_reason, p_note, p_notice } = args as { p_org_id: string; p_item_id: string; p_reason: string; p_note: string | null; p_notice: Record<string, unknown> };
    const uid = caller(who);
    if (!["owner", "admin"].includes(roleOf(p_org_id, uid) ?? "")) throw raise("workspace archive requires the admin or owner role", "42501");
    if (!String(p_reason ?? "").trim()) throw raise("a reason is required to archive for the workspace", "22023");
    const item = db.rows("intelligence_items").find((i) => i.id === p_item_id);
    if (!item) throw raise("no such item", "P0002");
    const members = new Set(db.rows("org_memberships").filter((m) => m.org_id === p_org_id).map((m) => m.user_id));
    const keys = [p_item_id, ...(item.legacy_id ? [String(item.legacy_id)] : [])];
    const watchers = db.rows("user_watchlist").filter((w) => members.has(w.user_id) && keys.includes(String(w.item_id))).map((w) => String(w.user_id));
    const owner = override(p_org_id, p_item_id)?.owner_user_id as string | null | undefined;
    const to = [...new Set([...watchers, ...(owner ? [owner] : [])])].filter((u) => u !== uid).sort();
    return commit(p_org_id, p_item_id, { is_archived: true, archive_reason: p_reason, ...(p_note == null ? {} : { archive_note: p_note }), archived_at: db.tick(), archived_by: uid }, to.map((user_id) => ({ user_id, kind: "archive", payload: { ...p_notice, item_id: p_item_id, archived_by: uid } })));
  });
  db.scriptRpc("assign_item", (args, who) => {
    const { p_org_id, p_item_id, p_owner_user_id, p_notice } = args as { p_org_id: string; p_item_id: string; p_owner_user_id: string | null; p_notice: Record<string, unknown> | null };
    const uid = caller(who);
    if (!["owner", "admin", "member"].includes(roleOf(p_org_id, uid) ?? "")) throw raise("a viewer can read this workspace but cannot assign an owner", "42501");
    if (p_owner_user_id && !["owner", "admin", "member"].includes(roleOf(p_org_id, p_owner_user_id) ?? "")) throw raise("the assignee is not a member who can own an item", "42501");
    if (!db.rows("intelligence_items").some((i) => i.id === p_item_id)) throw raise("no such item", "P0002");
    const notices = p_owner_user_id && p_owner_user_id !== uid && p_notice ? [{ user_id: p_owner_user_id, kind: "assignment", payload: { ...p_notice, item_id: p_item_id, assigned_by: uid } }] : [];
    return commit(p_org_id, p_item_id, { owner_user_id: p_owner_user_id, owner_assigned_by: p_owner_user_id ? uid : null, owner_assigned_at: p_owner_user_id ? db.tick() : null }, notices);
  });
  // assign_item_members (migration 0065): the gates, the rows stamped from the session and their outbox rows as ONE unit: a failed outbox insert leaves no assignment behind.
  db.scriptRpc("assign_item_members", (args, who) => {
    const { p_org_id, p_item_id, p_assignees, p_due_on, p_notice } = args as { p_org_id: string; p_item_id: string; p_assignees: string[]; p_due_on: string | null; p_notice: Record<string, unknown> };
    const uid = caller(who);
    if (!["owner", "admin", "member"].includes(roleOf(p_org_id, uid) ?? "")) throw raise("a viewer can read this workspace but cannot assign work", "42501");
    const ids = [...new Set(p_assignees ?? [])];
    if (ids.length === 0 || ids.length > 25) throw raise("assign between 1 and 25 people at a time", "22023");
    for (const a of ids) if (!["owner", "admin", "member"].includes(roleOf(p_org_id, a) ?? "")) throw raise("the assignee is not a member who can be assigned work", "42501");
    if (!db.rows("intelligence_items").some((i) => i.id === p_item_id)) throw raise("no such item", "P0002");
    const fresh = ids.filter((a) => !db.rows("item_assignments").some((r) => r.org_id === p_org_id && r.item_id === p_item_id && r.assignee_user_id === a));
    const notices = fresh.filter((a) => a !== uid).map((a) => ({ user_id: a, kind: "assignment", payload: { ...p_notice, item_id: p_item_id, assigned_by: uid, due_on: p_due_on } }));
    if (notices.length && db.takeFailure("notification_outbox", "insert", [])) throw raise("outbox down", "XX000");
    const created = fresh.map((a) => {
      const row = { id: db.nextId(), org_id: p_org_id, item_id: p_item_id, assignee_user_id: a, assigned_by: uid, due_on: p_due_on, state: "open", created_at: db.tick() };
      db.rows("item_assignments").push(row);
      return { ...row };
    });
    for (const n of notices) db.rows("notification_outbox").push({ ...n });
    return { created, already: ids.filter((a) => !fresh.includes(a)), queued: notices.length };
  });
  // workspace_tag_counts: every tag with the number of items it is applied to (0 for none).
  db.views.workspace_tag_counts = () =>
    (db.tables.workspace_tags ?? []).map((t) => ({ org_id: t.org_id, tag_id: t.id, item_count: (db.tables.item_workspace_tags ?? []).filter((l) => l.tag_id === t.id && l.org_id === t.org_id).length }));
  // org_watchers: members of the org who watch any of the items, and whether the team watchlist holds one.
  db.scriptRpc("org_watchers", (args) => {
    const { p_org_id, p_item_ids } = args as { p_org_id: string; p_item_ids: string[] };
    const failure = db.takeFailure("rpc:org_watchers", "rpc", []);
    if (failure) throw new Error(failure.message);
    const members = new Set((db.tables.org_memberships ?? []).filter((m) => m.org_id === p_org_id).map((m) => m.user_id));
    const watchers = [...new Set((db.tables.user_watchlist ?? []).filter((w) => members.has(w.user_id) && p_item_ids.includes(String(w.item_id))).map((w) => String(w.user_id)))].sort();
    return [{ watcher_ids: watchers, on_team_watchlist: (db.tables.org_watchlist ?? []).some((o) => o.org_id === p_org_id && p_item_ids.includes(String(o.item_id))) }];
  });
}

const personaOf = (request?: Request): Persona => {
  const token = request?.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  return (PERSONAS as string[]).includes(token) ? (token as Persona) : "anon";
};
const whoIs = (persona: Persona): Who | null => (persona === "anon" ? null : { claims: { sub: USER[persona], email: `${persona}@example.test` }, admin: persona === "platformAdmin" });

/** Script both client factories: the user client follows the bearer, the service client is the whole database. */
export function script(db: MemDb) {
  scripted.user = (request) => memClient(db, whoIs(personaOf(request)));
  scripted.service = () => memClient(db, null);
  return db;
}

/** A client for code that is handed one directly (stores, patch-workspace-settings). */
export const clientFor = (db: MemDb, persona: Persona = "owner") => memClient(db, whoIs(persona));

export const as = (persona: Persona, path: string, init: RequestInit = {}) =>
  new Request(`https://app.example.test${path}`, { ...init, headers: { ...(persona === "anon" ? {} : { authorization: `Bearer ${persona}` }), "content-type": "application/json", ...(init.headers ?? {}) } });
export const send = (persona: Persona, method: string, path: string, body?: unknown) => as(persona, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) }) as never;

type Handler = (request: Request, context: never) => Promise<Response>;

/** Call a handler as `persona` and return the status (and the parsed body). */
export async function call(handler: Handler, persona: Persona, method: string, path: string, body?: unknown, params: Record<string, string> = {}) {
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

export const E = (anon: number, viewer: number, member: number, admin: number, owner: number, otherOrgMember: number, platformAdmin: number): Record<Persona, number> => ({ anon, viewer, member, admin, owner, otherOrgMember, platformAdmin });

/** A persona matrix: the expected status for each of the seven personas, each run against a fresh database. */
export async function matrix(name: string, run: (persona: Persona, db: MemDb) => Promise<number>, expected: Record<Persona, number>) {
  for (const persona of PERSONAS) {
    const db = script(seed());
    assert.equal(await run(persona, db), expected[persona], `${name} as ${persona}`);
  }
}
