import type { CookieOptionsWithName } from "@supabase/ssr";

/** The session cookie's attributes on every Supabase client (the proxy's and the routes' server clients, the browser client): sent over https only, never on a cross-site subrequest, for the whole site. */
export function cookieOptions(): CookieOptionsWithName {
  return { secure: true, sameSite: "lax", path: "/" };
}
