/** The origin (scheme, host, port) of the Supabase project, or null when the address is unset or not a URL: the one outside host the browser may talk to (data, auth, storage). */
export function supabaseOriginOf(url: string | undefined): string | null {
  return (url ? URL.parse(url)?.origin : null) ?? null;
}

/**
 * The Content-Security-Policy of one response (audit 2.3.8). Scripts are this site's own plus inline ones, NOT a nonce: Next stamps a nonce only on a page it renders per request, and the login, sign-up, privacy and
 * reset pages are prerendered, so a nonce policy blocks every script on them (measured on `next start`, Next 16.1.6). Every other directive is enforced: styles allow inline (React `style` props and the map's
 * markers), and the rest is this site, the project's own origin for data, and OpenStreetMap's tile servers for the map's images. The dev server also needs eval.
 */
export function contentSecurityPolicy({ supabaseOrigin, production }: { supabaseOrigin: string | null; production: boolean }): string {
  const project = supabaseOrigin ? [supabaseOrigin] : [];
  return [
    ["default-src", "'self'"],
    ["script-src", "'self'", "'unsafe-inline'", ...(production ? [] : ["'unsafe-eval'"])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "https://*.tile.openstreetmap.org", ...project],
    ["connect-src", "'self'", ...project],
    ["font-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ]
    .map((d) => d.join(" "))
    .join("; ");
}
