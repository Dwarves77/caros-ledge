// Ported from old_repo/src/lib/auth/route-policy.ts (lines 1-87)
// Ported from old_repo/src/lib/auth/safe-return-path.mjs (lines 1-12)
const PUBLIC_ROUTES = ["/login", "/signup", "/auth/callback", "/auth/reset-password", "/privacy"];
const STATIC_PREFIXES = ["/_next", "/api"];
const STATIC_FILES = ["/robots.txt", "/favicon.ico"];
// Deliberately narrow: only path prefixes that are exclusively WordPress or PHP territory, never a route of this app.
const SCANNER_PREFIXES = ["/wp-admin", "/wp-includes", "/wp-content", "/wp-login", "/xmlrpc.php"];

/** A path is under a route when it IS the route or continues past a "/": `/loginx` and `/privacy-evil` are not under `/login` and `/privacy`. */
const under = (pathname: string, route: string): boolean => pathname === route || pathname.startsWith(`${route}/`);

export const isScannerProbe = (pathname: string): boolean => SCANNER_PREFIXES.some((p) => pathname.startsWith(p)) || pathname.endsWith(".php");
const isPublicRoute = (pathname: string): boolean => PUBLIC_ROUTES.some((r) => under(pathname, r));
const isStaticOrApi = (pathname: string): boolean => STATIC_PREFIXES.some((p) => under(pathname, p)) || STATIC_FILES.includes(pathname);

export type RouteDecision =
  | { action: "scanner-404" }
  | { action: "allow" }
  /** A signed-in visitor hit /login or /signup. */
  | { action: "redirect-home" }
  /** A protected route without a session: /login, carrying the original path and query as the return target. */
  | { action: "redirect-login"; redirectTo: string };

/** The one routing decision per request, pure: scanner probes, public routes, static and api passthrough, then the protected gate. */
export function decideRoute({ pathname, search = "", authenticated }: { pathname: string; search?: string; authenticated: boolean }): RouteDecision {
  if (isScannerProbe(pathname)) return { action: "scanner-404" };
  if (isPublicRoute(pathname)) return authenticated && (pathname === "/login" || pathname === "/signup") ? { action: "redirect-home" } : { action: "allow" };
  if (isStaticOrApi(pathname)) return { action: "allow" };
  return authenticated ? { action: "allow" } : { action: "redirect-login", redirectTo: `${pathname}${search}` };
}

/** A same-origin path, or "/". Rejects non-paths, `//host`, `/\host` and any control character (a tab or newline would make `/\t/host` protocol-relative in a browser). */
export function sanitizeReturnPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return /[\u0000-\u001f\u007f]/.test(raw) ? "/" : raw;
}
