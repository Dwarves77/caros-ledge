// Ported from old_repo/src/app/api/telemetry/error/route.ts (lines 11-44)
import { HttpError, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { captureError } from "@/core/shared/telemetry";

/** A legitimate error report is well under this; anything larger is malformed or abusive and refused before it is parsed. */
export const BODY_MAX_BYTES = 32 * 1024;

/** POST /api/telemetry/error: the client error ingest. Authenticated, bounded, and a message is required; user_scope stays null (no PII, no per-error lookup). Answers 204. */
export const POST = route("/api/telemetry/error", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  const raw = await request.text();
  if (raw.length > BODY_MAX_BYTES) throw new HttpError(413, "Payload too large");
  let payload: { message?: unknown; stack?: unknown; path?: unknown };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  const message = typeof payload?.message === "string" ? payload.message : "";
  if (!message) throw new HttpError(400, "message is required");
  await captureError({ side: "client", route: typeof payload.path === "string" ? payload.path : "", error: message, stack: typeof payload.stack === "string" ? payload.stack : null, userScope: null });
  return new Response(null, { status: 204 });
});
