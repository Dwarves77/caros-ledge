// Ported from old_repo/src/components/onboarding/InvitationLandingPage.tsx (lines 57-90)
export interface JsonResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** The server's own message for a refusal, else a plain sentence; null when the request landed. */
  error: string | null;
}

export const SIGNED_OUT_MESSAGE = "You are signed out. Sign in and try again.";
export const UNREACHABLE_MESSAGE = "The request could not be sent. Check your connection and try again.";

/**
 * The one browser call to the app's own routes: it never throws, so a network failure is a result the screen shows (B-0163: a fetch outside a try left
 * "Accepting..." on forever), and a refusal carries the server's message. The session travels as the cookie.
 */
export async function requestJson<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<JsonResult<T>> {
  try {
    const response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (response.ok) return { ok: true, status: response.status, data, error: null };
    const said = typeof data?.error === "string" ? data.error : "";
    return { ok: false, status: response.status, data, error: said || (response.status === 401 ? SIGNED_OUT_MESSAGE : `The request failed (${response.status}).`) };
  } catch {
    return { ok: false, status: 0, data: null, error: UNREACHABLE_MESSAGE };
  }
}
