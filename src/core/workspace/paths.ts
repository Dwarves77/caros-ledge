// Pure path helpers of the workspace: no server module, no environment, so a client component may import them (scripts/ci/checks/client-walk.mjs). roster.ts holds the server side and imports the route guard.
const DETAIL_PATH_RE = /^\/(?:regulations|market|operations|research)\/([^/]+)\/?$/;

/** The item id a detail page addresses, read from its own pathname; null on any other path. */
export function itemIdFromDetailPath(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null;
  const m = DETAIL_PATH_RE.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}
