/**
 * The app's own address, the one origin an invitation link is built on. It comes from NEXT_PUBLIC_APP_URL and from nothing a request says: a link built on the request's Origin header lets a caller mail
 * an invitation pointing at a host of their choosing from our sender (audit 2.3.7). https only; http is allowed outside production so a workstation can run. A trailing slash is dropped.
 */
export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  const url = raw ? URL.parse(raw) : null;
  const allowed = url && (url.protocol === "https:" || (url.protocol === "http:" && process.env.NODE_ENV !== "production"));
  if (!url || !allowed) throw new Error("NEXT_PUBLIC_APP_URL is not configured");
  return url.href.replace(/\/+$/, "");
}
