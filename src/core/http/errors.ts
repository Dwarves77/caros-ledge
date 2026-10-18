// Ported from old_repo/src/app/api/invitations/[token]/accept/route.ts (lines 24-39)
// Ported from old_repo/src/app/api/invitations/[token]/decline/route.ts (lines 24-38)
// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/[id]/route.ts (lines 41-55)
// Ported from old_repo/src/lib/api/route-guard.ts (lines 30-37)
import { log } from "@/core/shared/log";
import { withErrorCapture } from "@/core/shared/telemetry";

/** The one error shape: `{ error: string }` with a status. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** What the response body says. It is `message` unless a subclass holds a driver sentence back for the log. */
  readonly publicMessage: string;
  constructor(status: number, message: string, headers: Record<string, string> = {}, publicMessage?: string) {
    super(message);
    this.publicMessage = publicMessage ?? message;
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

export const LOOKUP_SENTENCE = "That could not be read just now. Try again in a moment.";

/** A read behind a guard or a handler failed. Answered 503 with Retry-After and retried by the client: never read as "not a member" or "no workspace". The body carries a customer sentence; the driver's message (`message`) goes to the log only. */
export class LookupError extends HttpError {
  constructor(step: string, cause: unknown) {
    super(503, `lookup failed at ${step}: ${cause && typeof cause === "object" && "message" in cause ? String((cause as { message: unknown }).message) : String(cause)}`, { "Retry-After": "1" }, LOOKUP_SENTENCE);
    this.name = "LookupError";
  }
}

export function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers });
}

/** A success body with the caller's rate-limit headers. */
export function ok(headers: Record<string, string>, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

/** Postgres and PostgREST codes to HTTP statuses: the one map. */
export function statusForDb(code: string | null | undefined): number {
  switch (code) {
    case "42501":
    case "PGRST301":
      return 403;
    case "P0002":
      return 404;
    case "22023":
    case "23505":
      return 409;
    default:
      return 500;
  }
}

/** A database failure as an HttpError. `messages` replaces the text where the database message is not for users. */
export function dbError(error: { message: string; code?: string | null }, messages: { forbidden?: string; notFound?: string } = {}): HttpError {
  const status = statusForDb(error.code);
  return new HttpError(status, (status === 403 ? messages.forbidden : status === 404 ? messages.notFound : undefined) ?? error.message);
}

/** An HttpError as its response: the public sentence in the body, the held-back detail in the log. */
export function answer(e: HttpError): Response {
  if (e.publicMessage !== e.message) log.warn(`[http] ${e.status} held back from the response:`, e.message);
  return refuse(e.status, e.publicMessage, e.headers);
}

/** A route handler: an HttpError becomes its response, any other throw is captured and re-raised. */
export function route<Ctx>(name: string, handler: (request: Request, context: Ctx) => Promise<Response>): (request: Request, context: Ctx) => Promise<Response> {
  return withErrorCapture(name, async (request, context) => {
    try {
      return await handler(request, context);
    } catch (e) {
      if (e instanceof HttpError) return answer(e);
      throw e;
    }
  });
}
