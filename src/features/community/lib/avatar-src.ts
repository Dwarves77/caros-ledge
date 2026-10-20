// New in R2e (M3). The one rule for which headshot address a browser may be sent to: the app's own storage origin, nothing an author typed (migration 0103 also refuses a non-https address at write time).
/** The address to draw for a headshot, or null: https on the app's storage origin (`supabaseUrl`'s origin, path /storage/v1/) and nothing else. Pure. */
export function avatarSrc(url: string | null | undefined, supabaseUrl: string | null | undefined): string | null {
  if (!url || !supabaseUrl) return null;
  try {
    const want = new URL(supabaseUrl);
    const got = new URL(url);
    return got.protocol === "https:" && got.origin === want.origin && got.pathname.startsWith("/storage/v1/") ? got.toString() : null;
  } catch {
    return null;
  }
}
