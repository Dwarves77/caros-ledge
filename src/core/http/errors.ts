// Ported from old_repo/src/app/api/invitations/[token]/accept/route.ts (lines 24-39)
// Ported from old_repo/src/app/api/invitations/[token]/decline/route.ts (lines 24-38)
// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/[id]/route.ts (lines 41-55)
// Ported from old_repo/src/lib/api/route-guard.ts (lines 30-37)
import { log } from "@/core/shared/log";
import { withErrorCapture } from "@/core/shared/telemetry";

import { DB_SENTENCES, LOOKUP_SENTENCE, statusForDb } from "./failure";

export { LOOKUP_SENTENCE, statusForDb };

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

/**
 * A database failure as an HttpError. The body is ALWAYS a customer sentence (the caller's `messages` for 403 and 404 where it has a better one, else the table for the status); the driver's code and message are held back for
 * the log (`answer` logs them), so a constraint name, a table name or a SQL state never reaches a customer (register core:21, workspace-admin-community:19). A transient failure answers 503 with Retry-After.
 */
export function dbError(error: { message: string; code?: string | null }, messages: { forbidden?: string; notFound?: string } = {}): HttpError {
  const status = statusForDb(error.code);
  const sentence = (status === 403 ? messages.forbidden : status === 404 ? messages.notFound : undefined) ?? DB_SENTENCES[String(status)] ?? (DB_SENTENCES["500"] as string);
  return new HttpError(status, `database ${error.code ?? "error"}: ${error.message}`, status === 503 ? { "Retry-After": "1" } : {}, sentence);
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
