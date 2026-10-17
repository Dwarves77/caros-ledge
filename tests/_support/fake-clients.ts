// Stands in for src/core/db/clients.ts for every source module under test (see scripts/lib/ts-hooks.mjs).
import * as real from "../../src/core/db/clients.ts";

export const { bearerToken, describeError, isServiceConfigured, isSupabaseConfigured } = real;

type Factory<T> = (request?: Request) => T | Promise<T>;
/** What the next call to userClient() and serviceClient() returns; a test sets these. */
export const scripted: { user: Factory<unknown> | null; service: Factory<unknown> | null } = { user: null, service: null };

export async function userClient(request?: Request) {
  if (!scripted.user) throw new Error("test did not script userClient");
  return scripted.user(request);
}
export function serviceClient() {
  if (!scripted.service) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured (test)");
  return scripted.service() as never;
}
export function requestClient(): never {
  throw new Error("requestClient is not scripted");
}
export function anonClient(): never {
  throw new Error("anonClient is not scripted: a test passes the map read its own db");
}
