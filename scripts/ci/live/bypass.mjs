// The Vercel deployment-protection bypass, shared by the capture (tests/parity/capture.mjs, tests/ux/ux-smoke.mjs) and the live checks (scripts/ci/live-checks.mjs). A deployed preview sits behind Vercel's deployment
// protection; the project's automation bypass secret (VERCEL_AUTOMATION_BYPASS_SECRET) lets a browser through. The header goes to the target origin ONLY: never to a third party the page happens to call (the database, map tiles, an
// embedded origin), because the secret opens every preview of the project. A context-wide extraHTTPHeaders would send it to all of them; this route does not.
export const BYPASS_HEADER = 'x-vercel-protection-bypass';

/** The header for one request URL: present only when the secret is set and the URL's origin is the target origin (a look-alike host is a different origin). */
export function bypassHeaders(url, origin, env = process.env) {
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret && new URL(url).origin === new URL(origin).origin ? { [BYPASS_HEADER]: secret } : {};
}

/** Adds the header to the requests of a Playwright browser context that go to `origin` (a URL or an origin; only its origin is used). Nothing is installed without a secret. */
export async function installBypass(context, origin, env = process.env) {
  if (!env.VERCEL_AUTOMATION_BYPASS_SECRET) return;
  await context.route('**/*', (route) => {
    const extra = bypassHeaders(route.request().url(), origin, env);
    return Object.keys(extra).length ? route.continue({ headers: { ...route.request().headers(), ...extra } }) : route.fallback();
  });
}
