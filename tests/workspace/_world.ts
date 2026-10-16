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
  return new MemDb({
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
