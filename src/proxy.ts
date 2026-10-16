// Ported from old_repo/src/proxy.ts (lines 1-105)
import { NextResponse, type NextRequest } from "next/server";

import { ClaimsUnavailable, getClaims } from "@/core/auth/claims";
import { decideRoute } from "@/core/auth/route-policy";
import { requestClient } from "@/core/db/clients";
import { log } from "@/core/shared/log";

/** The Next proxy: build the request-bound client, verify the session locally, apply decideRoute. */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (decideRoute({ pathname, authenticated: false }).action === "scanner-404") return new NextResponse(null, { status: 404 });

  let response = NextResponse.next({ request });
  const client = requestClient(request.cookies, (cookiesToSet) => {
    cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
    response = NextResponse.next({ request });
    cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
  });

  // An unreachable auth service must not throw out of the proxy (a platform 503 that bypasses every fail-closed handler):
  // a protected route answers a 503 page with Retry (IMP-015), never the login form; a public route is served as usual.
  let authenticated = false;
  let authUnavailable = false;
  try {
    authenticated = (await getClaims(client)) !== null;
  } catch (e) {
    if (!(e instanceof ClaimsUnavailable)) throw e;
    authUnavailable = true;
    log.warn("[proxy] claims verification unavailable:", e.message);
  }

  const decision = decideRoute({ pathname, search, authenticated, authUnavailable });
  switch (decision.action) {
    case "scanner-404":
      return new NextResponse(null, { status: 404 });
    case "redirect-home":
      return NextResponse.redirect(new URL("/", request.url));
    case "redirect-login": {
      const url = new URL("/login", request.url);
      url.searchParams.set("redirect", decision.redirectTo);
      return NextResponse.redirect(url);
    }
    case "service-unavailable": {
      const res = NextResponse.rewrite(new URL("/service-unavailable", request.url), { status: 503 });
      res.headers.set("Retry-After", "10");
      return res;
    }
    case "allow":
      return response;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
