import { fakeDb, signedIn, signedOut, type Call, type ClaimsReply, type Reply } from "./fake-db.ts";
import { scripted } from "./fake-clients.ts";

export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";
export const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";
export const OTHER_MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";

export type Persona = "anon" | "viewer" | "otherOrgMember" | "member" | "owner" | "platformAdmin";
export const PERSONAS: Persona[] = ["anon", "viewer", "otherOrgMember", "member", "owner", "platformAdmin"];

const WHO: Record<Exclude<Persona, "anon">, { id: string; org: string | null; role: string | null }> = {
  viewer: { id: "u-viewer", org: ORG_A, role: "viewer" },
  otherOrgMember: { id: "u-other", org: ORG_B, role: "owner" },
  member: { id: "u-member", org: ORG_A, role: "member" },
  owner: { id: "u-owner", org: ORG_A, role: "owner" },
  platformAdmin: { id: "u-admin", org: null, role: null },
};

export function personaOf(request?: Request): Persona {
  const token = request?.headers.get("authorization")?.replace("Bearer ", "");
  return (PERSONAS as string[]).includes(token ?? "") ? (token as Persona) : "anon";
}

export const claimsFor = (persona: Persona): ClaimsReply => (persona === "anon" ? signedOut : signedIn(WHO[persona].id));

/** The caller's own RLS-bound client: their membership rows and their own is_platform_admin answer. */
export function userDbFor(persona: Persona, extra?: (call: Call) => Reply | undefined, rpcExtra?: (name: string, args: unknown) => Reply | undefined) {
  return fakeDb(
    (call) => {
      const custom = extra?.(call);
      if (custom) return custom;
      if (persona !== "anon" && call.table === "org_memberships" && call.filters.some(([k]) => k === "eq:user_id")) {
        const who = WHO[persona];
        const asked = call.filters.find(([k]) => k === "eq:org_id")?.[1];
        if (!who.org || (asked && asked !== who.org)) return { data: null };
        return { data: { org_id: who.org, role: who.role, organizations: { id: who.org, name: "Org A", workspace_settings: [{ sector_profile: ["air"] }] } } };
      }
      if (call.table === "profiles" && call.columns?.includes("sector_overrides")) return { data: { sector_overrides: [] } };
      return undefined;
    },
    { claims: claimsFor(persona), rpc: (name, args) => (name === "is_platform_admin" ? { data: persona === "platformAdmin" } : rpcExtra?.(name, args)) },
  );
}

/** Script both client factories for one request: the user client follows the bearer, the service client is `service`. */
export function script(service: ReturnType<typeof fakeDb>, userExtra?: (call: Call) => Reply | undefined, userRpc?: (name: string, args: unknown) => Reply | undefined) {
  scripted.user = (request) => userDbFor(personaOf(request), userExtra, userRpc).db;
  scripted.service = () => service.db;
  return service;
}

export const as = (persona: Persona, url: string, init: RequestInit = {}) =>
  new Request(`https://app.example.test${url}`, { ...init, headers: { ...(persona === "anon" ? {} : { authorization: `Bearer ${persona}` }), "content-type": "application/json", ...(init.headers ?? {}) } });
export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
export const json = (body: unknown) => JSON.stringify(body);
